# Export file format (.qsx)

Security QuickScan exports the scan history of one or more organisations to a `.qsx` file, and imports it again into the same or another installation. This page describes version 1 of the format. The implementation is in `apps/server/src/portability/`.

## Envelope

The file is UTF-8 JSON:

```json
{
  "format": "security-quickscan-export",
  "version": 1,
  "createdAt": "2026-10-04T08:00:00.000Z",
  "kdf": { "alg": "argon2id", "memoryKiB": 65536, "iterations": 3, "parallelism": 1, "salt": "<base64, 16 bytes>" },
  "cipher": { "alg": "aes-256-gcm", "iv": "<base64, 12 bytes>" },
  "data": "<base64 of ciphertext followed by the 16 byte GCM tag>"
}
```

- **Key:** 32 bytes derived from the passphrase (Unicode NFC) with Argon2id, using the parameters and salt in `kdf`. Importers accept memory from 19 MiB to 256 MiB, 2 to 10 iterations and a parallelism of 1 to 4, so a crafted file cannot exhaust the server.
- **Encryption:** AES-256-GCM with the `iv` above. The additional authenticated data is the canonical JSON of the header: every field except `data`, with object keys sorted and no whitespace. Changing any header field, or any byte of `data`, makes decryption fail.
- **Errors:** a wrong passphrase and a modified file give the same message ("The passphrase is wrong or the file was modified"), so the two cannot be told apart.
- **Plaintext:** the payload JSON below, compressed with gzip. Importers stop decompressing at 256 MB.
- **Versions:** a file with a higher `version` (envelope) or `schemaVersion` (payload) than the importer knows is refused with a message to update the installation first.

## Payload, schema version 1

```json
{
  "format": "security-quickscan-export",
  "schemaVersion": 1,
  "appVersion": "1.0.0",
  "exportedAt": "2026-10-04T08:00:00.000Z",
  "exportedBy": { "name": "Ada Analyst", "email": "ada@example.com" },
  "scope": "organisation",
  "organisations": [ ... ]
}
```

`scope` is `organisation` for a single organisation and `all` for Export all. All timestamps are ISO 8601 with an offset.

### Organisation

| Field | Meaning |
| --- | --- |
| `exportId` | Original identity: the id the organisation was first imported from, else its own id. |
| `name`, `createdAt` | As in the source installation. |
| `ownerEmail` | Owner's email address; null when the exporter does not manage the organisation. |
| `shares` | `[{ email, permission }]` with `view` or `edit`; empty when the exporter does not manage the organisation. |
| `triage` | `[{ checkId, systemKey, status, note, updatedAt, updatedByEmail }]`; `status` is `open`, `accepted` or `false_positive`. |
| `scans` | Finished scans, oldest first. |

### Scan

| Field | Meaning |
| --- | --- |
| `exportId` | Original identity of the scan, as for organisations. |
| `name`, `status` | `status` is `completed`, `failed` or `cancelled`; drafts and running scans are not exported. |
| `createdAt`, `queuedAt`, `startedAt`, `finishedAt` | Original timestamps (comparisons and trends depend on them). |
| `score`, `grade` | As stored when the scan finished. |
| `summary` | The frozen score summary with the triage it was computed with. `controls[].checks[].systemId` refers to `systems[].exportId`. |
| `systems` | Scanned systems in the order they were added. |
| `results` | One per system and check. |
| `excludedChecks` | `[{ checkId, reason }]`, only for scans from before every check always ran. |

### System

`{ exportId, provider, label, environment, config, startedConfig, connectionOk, connectionMessage, connectionDetails, connectionCheckedAt, createdAt }`. `provider` is `m365`, `azure`, `aws` or `github`. `config` and `startedConfig` hold the non-secret configuration only (tenant, account, organisation, access method). Credentials, their hints and their expiry are never exported.

### Result

`{ system, checkId, status, summary, resources, evidence, startedAt, finishedAt }`. `system` is a `systems[].exportId` of the same scan; `status` is `pass`, `fail`, `warn`, `na`, `error`, `pending` or `running`. Results of checks the importing version does not know are stored and shown once its catalog has them.

## Limits

At most 500 organisations and 10,000 scans per file, 200 systems per scan, 100,000 results per scan, and a file size of 48 MB for the web import. Strings and lists are bounded as well; a file that exceeds a limit or does not match the schema is refused before anything is written.

## Import rules

- An organisation merges into an existing one with the same original identity that the importer may edit (administrators: any). Otherwise a new organisation is created, owned by the importer, with `exportId` as its original identity. Demo organisations are never merged into.
- A scan is skipped when the organisation already has a scan with the same original identity. New scans get new ids, keep their original timestamps, are kept until deleted by hand, and record when and by whom they were imported.
- Triage merges per check and system key: the decision with the newer `updatedAt` wins.
- Only administrators restore the owner and shares, by email address, for active accounts that exist in the installation. Viewer accounts always get view access.
- Microsoft tenant links are never created: systems that used admin consent need consent again before they are scanned. AWS role systems get a new external ID.
