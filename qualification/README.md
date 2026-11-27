# Runtime qualification records

- `records/`: durable copies of acceptance evidence, written by
  `node script/qualification.mjs record --run RUN_ID`. Records never qualify
  anything on their own.
- `promotions.json`: the reviewed list of exact pins and scopes promoted to
  qualified. It is empty.
- `schema/`: JSON Schemas for records and promotions.

See [runtime qualification](../docs/runtime-qualification.md) for the record
format, promotion steps and how the executor and daemon derive `qualified`.
