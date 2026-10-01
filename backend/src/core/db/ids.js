import { v7 as uuidv7, validate, version } from 'uuid';

/** Time-ordered UUIDv7 for primary keys: keeps B-tree inserts append-mostly. */
export const newId = () => uuidv7();

export const isUuid = (value) => typeof value === 'string' && validate(value);

export const isUuidV7 = (value) => isUuid(value) && version(value) === 7;
