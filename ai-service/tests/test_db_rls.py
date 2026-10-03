"""Database-level guarantees for the AI role (ADR-0004, ADR-0022), against real PostgreSQL.

Runs only with AI_DB_TESTS=1 (inside the compose network). Every test works in a
transaction that is rolled back, so nothing is left behind.
"""

import os
import uuid

import psycopg
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("AI_DB_TESTS") != "1", reason="needs PostgreSQL")


@pytest.fixture
def conn():
    with psycopg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "5432")),
        dbname=os.environ["POSTGRES_DB"],
        user=os.environ["DB_AI_USER"],
        password=os.environ["DB_AI_PASSWORD"],
    ) as connection:
        yield connection


def scoped(conn, patient_id: str | None):
    conn.execute("SELECT set_config('ai.patient_id', %s, true)", (patient_id or "",))


def insert_run(conn, patient_id: str) -> str:
    run_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO ai.ai_runs (id, workflow, patient_id, status) VALUES (%s, 'test', %s, 'ok')",
        (run_id, patient_id),
    )
    return run_id


def insert_extraction(conn, patient_id: str, run_id: str) -> None:
    conn.execute(
        """INSERT INTO ai.document_extractions (id, patient_id, document_id, document_type, version,
             run_id, input_sha256, prompt_version, status, text_source)
           VALUES (%s, %s, %s, 'lab_report', 1, %s, %s, 'test', 'completed', 'pdf_text')""",
        (str(uuid.uuid4()), patient_id, str(uuid.uuid4()), run_id, "a" * 64),
    )


@pytest.mark.parametrize(
    "table", ["patients", "medical_documents", "consents", "lab_results", "users", "appointments"]
)
def test_ai_role_has_no_access_to_core_tables(conn, table) -> None:
    with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
        conn.execute(f"SELECT 1 FROM public.{table} LIMIT 1")  # noqa: S608 - fixed names


def test_without_scope_nothing_is_visible_or_writable(conn) -> None:
    with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
        scoped(conn, None)
        insert_run(conn, str(uuid.uuid4()))


def test_scope_isolates_patients(conn) -> None:
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    with conn.transaction(force_rollback=True):
        scoped(conn, a)
        insert_extraction(conn, a, insert_run(conn, a))
        assert conn.execute("SELECT count(*) FROM ai.document_extractions").fetchone()[0] >= 1
        scoped(conn, b)
        visible = conn.execute(
            "SELECT count(*) FROM ai.document_extractions WHERE patient_id = %s", (a,)
        ).fetchone()[0]
        assert visible == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
        scoped(conn, b)
        insert_run(conn, a)  # writing another patient's artifact under B's scope


def test_ai_history_cannot_be_deleted_or_rewritten(conn) -> None:
    a = str(uuid.uuid4())
    with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
        scoped(conn, a)
        conn.execute("DELETE FROM ai.ai_runs WHERE patient_id = %s", (a,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
        scoped(conn, a)
        conn.execute("UPDATE ai.document_extractions SET status = 'completed'")


async def test_hybrid_retrieval_is_patient_and_document_scoped() -> None:
    from app.embeddings import HashingEmbeddingProvider, to_pgvector
    from app.rag.retrieval import hybrid_search

    embedder = HashingEmbeddingProvider()
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    d1, d2 = str(uuid.uuid4()), str(uuid.uuid4())
    conn = await psycopg.AsyncConnection.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "5432")),
        dbname=os.environ["POSTGRES_DB"],
        user=os.environ["DB_AI_USER"],
        password=os.environ["DB_AI_PASSWORD"],
    )
    try:
        async with conn.transaction(force_rollback=True):
            await conn.execute("SELECT set_config('ai.patient_id', %s, true)", (a,))
            run = str(uuid.uuid4())
            await conn.execute(
                "INSERT INTO ai.ai_runs (id, workflow, patient_id, status) VALUES (%s,'t',%s,'ok')",
                (run, a),
            )
            for doc, text in ((d1, "Hemoglobin: 12.9 g/dL"), (d2, "Hemoglobin: 9.1 g/dL secret")):
                ext = str(uuid.uuid4())
                await conn.execute(
                    """INSERT INTO ai.document_extractions (id, patient_id, document_id,
                         document_type, version, run_id, input_sha256, prompt_version, status,
                         text_source)
                       VALUES (%s,%s,%s,'lab_report',1,%s,%s,'t','completed','pdf_text')""",
                    (ext, a, doc, run, "b" * 64),
                )
                vec = to_pgvector((await embedder.embed([text]))[0])
                await conn.execute(
                    """INSERT INTO ai.document_chunks (id, patient_id, document_id, document_type,
                         extraction_id, chunk_index, content, embedding)
                       VALUES (%s,%s,%s,'lab_report',%s,0,%s,%s::extensions.vector)""",
                    (str(uuid.uuid4()), a, doc, ext, text, vec),
                )
            hits = await hybrid_search(conn, embedder, "hemoglobin", [d1])
            assert {h.document_id for h in hits} == {d1}
            assert all("secret" not in h.text for h in hits)
            # Another patient's scope sees nothing, even naming the same document.
            await conn.execute("SELECT set_config('ai.patient_id', %s, true)", (b,))
            assert await hybrid_search(conn, embedder, "hemoglobin", [d1, d2]) == []
    finally:
        await conn.close()
