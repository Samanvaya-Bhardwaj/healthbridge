"""Minimal synthetic PDF generator for tests (text-only, Helvetica, one page)."""


def _escape(line: str) -> str:
    return line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(lines: list[str]) -> bytes:
    text = " T* ".join(f"({_escape(line)}) Tj" for line in lines)
    stream = f"BT /F1 11 Tf 50 750 Td 14 TL {text} ET".encode("latin-1")
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
        b"/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
        b"<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<</Size {len(objects) + 1}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


SYNTHETIC_CBC = [
    "Sunrise Diagnostics Laboratory, Pune",
    "Report date: 2026-09-14",
    "Patient: Synthetic Patient (TEST DATA)",
    "Complete Blood Count",
    "Hemoglobin: 13.2 g/dL (ref 12.0-15.5)",
    "WBC: 11.8 10^3/uL (ref 4.0-11.0)",
    "Platelets: 250 10^3/uL (ref 150-450)",
    "Fasting Glucose: 92 mg/dL (ref 70-99)",
]
