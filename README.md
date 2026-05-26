# workflow-migrator

> Convert workflow definitions from Netflix Conductor and Camunda BPM to AWS Step Functions Amazon States Language (ASL).

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green?logo=nodedotjs)](https://nodejs.org/)
[![Jest](https://img.shields.io/badge/Jest-29.7-red?logo=jest)](https://jestjs.io/)
[![License](https://img.shields.io/badge/License-MIT-lightgrey)](./LICENSE)
[![CLI](https://img.shields.io/badge/CLI-npx_ready-orange)](https://www.npmjs.com/package/workflow-migrator)

---

## The Problem

Enterprise organizations migrating from self-hosted workflow orchestration platforms to AWS Step Functions face a manual, error-prone translation process. A typical Conductor workflow with 15 tasks takes 2-3 days to manually convert to ASL — mapping constructs, translating expressions, wiring retry/catch blocks, and validating the output.

This CLI automates the structural conversion in seconds:

```bash
npx workflow-migrator convert --from conductor --input workflow.json --output state-machine.asl.json
```

---

## Installation

```bash
# Run directly with npx (no install required)
npx workflow-migrator convert --from conductor --input workflow.json

# Or install globally
npm install -g workflow-migrator
```

### Prerequisites

| Requirement | Minimum Version |
|---|---|
| Node.js | 20.x |
| npm | 9.x |

---

## Quick Start

```bash
# Convert a Conductor workflow to Step Functions ASL
workflow-migrator convert --from conductor --input my-workflow.json --output my-workflow.asl.json

# Validate without converting
workflow-migrator validate --input my-workflow.json

# View supported platforms and mappings
workflow-migrator supported
```

---

## Configuration

### CLI Flags

| Flag | Description | Default |
|---|---|---|
| `--from <platform>` | Source platform (`conductor`) | Required |
| `--input <file>` | Input workflow definition file | Required |
| `--output <file>` | Output ASL file | stdout |
| `--no-pretty` | Disable pretty-printing | Pretty on |
| `-v, --verbose` | Debug logging | Off |
| `-q, --quiet` | Errors only | Off |

---

## Supported Platforms

| Platform | Status | Input Format | Output |
|---|---|---|---|
| Netflix Conductor | ✅ Supported | JSON DSL | ASL JSON |
| Camunda BPM | 🔜 Coming soon | BPMN 2.0 XML | ASL JSON |
| Temporal | 🔜 Planned | — | ASL JSON |

---

## API / CLI Reference

### `convert` — Convert a workflow definition

```bash
workflow-migrator convert --from conductor --input workflow.json --output state-machine.asl.json
```

**Output:** ASL JSON with migration comments, retry/catch blocks, and expression mappings.

### `validate` — Validate a workflow definition

```bash
workflow-migrator validate --input workflow.json
```

**Output:** Workflow name, version, task count, task types, timeout.

### `supported` — List platforms and construct mappings

```bash
workflow-migrator supported
```

### Exit Codes

| Exit Code | Meaning | Error Code |
|---|---|---|
| 0 | Success | — |
| 1 | User input error (bad args, file not found) | `INVALID_INPUT`, `FILE_NOT_FOUND`, `UNSUPPORTED_PLATFORM` |
| 2 | Invalid workflow (parse/validation failure) | `PARSE_ERROR`, `VALIDATION_ERROR` |
| 3 | Conversion failure | `CONVERSION_ERROR` |
| 4 | Resource limit exceeded | `FILE_TOO_LARGE` |
| 99 | Unexpected error | — |

---

## Construct Mapping

### Conductor → Step Functions

| Conductor Construct | Step Functions Equivalent | Notes |
|---|---|---|
| HTTP / SIMPLE | Task (Lambda Invoke) | Business logic moves to Lambda |
| DECISION / SWITCH | Choice | Case values map to Choice rules |
| FORK_JOIN | Parallel | Verify branch independence |
| JOIN | (implicit in Parallel) | Parallel state handles synchronization |
| SUB_WORKFLOW | Task (StartExecution.sync) | Nested state machine execution |
| WAIT | Wait | Duration preserved |
| TERMINATE | Fail | Maps to terminal error state |
| DO_WHILE | Choice + loop pattern | Requires manual review |

### Expression Mapping

| Conductor Expression | Step Functions JsonPath |
|---|---|
| `${workflow.input.field}` | `$.field` |
| `${taskRef.output.response.body.field}` | `$.taskRef.field` |

---

## Architecture

```
src/
├── index.ts                    # CLI entry point (Command pattern)
├── parsers/
│   └── conductor.ts            # Parse + validate Conductor JSON DSL
├── mappers/
│   └── conductor-to-asl.ts     # Convert Conductor → ASL (Strategy pattern)
├── types/
│   ├── conductor.ts            # Conductor workflow type definitions
│   └── asl.ts                  # Amazon States Language type definitions
└── utils/
    ├── logger.ts               # Structured logger (Singleton)
    ├── errors.ts               # Custom error hierarchy with error codes
    └── constants.ts            # Configuration limits and constants
```

**Design Patterns:**
- **Command** — CLI commands via Commander.js
- **Strategy** — Platform-specific parsers and mappers (extensible for Camunda, Temporal)
- **Singleton** — Logger instance shared across modules
- **Factory** — Typed errors with codes for programmatic handling

---

## JSON Output Format

```json
{
  "Comment": "Migrated from Conductor workflow: my_workflow (v1)",
  "StartAt": "ExtractMediaInfo",
  "States": {
    "ExtractMediaInfo": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:extract_media_info",
      "Comment": "Migrated from Conductor HTTP task: extract_media_info",
      "Retry": [{ "ErrorEquals": ["States.ALL"], "IntervalSeconds": 2, "MaxAttempts": 2, "BackoffRate": 2 }],
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "HandleError", "ResultPath": "$.error" }],
      "Next": "DecideProcessing"
    }
  },
  "TimeoutSeconds": 600
}
```

---

## Development

```bash
git clone https://github.com/mopyle4/workflow-migrator.git
cd workflow-migrator
npm install

# Build
npm run build

# Run in development mode
npm run dev -- convert --from conductor --input examples/workflow.json

# Run tests
npm test

# Lint
npm run lint
```

---

## Security

- **Input validation:** File size checked before reading (max 10MB)
- **No network access:** Operates entirely offline on local files
- **No secrets handling:** Does not read, store, or transmit credentials
- **Placeholder ARNs:** Output uses `${AWS::Region}` and `${AWS::AccountId}` — never real account IDs
- **Least privilege in generated ASL:** Each Task state targets a specific function ARN

---

## Performance

| Metric | Value |
|---|---|
| Time complexity | O(n) where n = total tasks |
| Space complexity | O(n) for generated state machine |
| Max input size | 10MB |
| Max tasks per workflow | 500 |
| Runtime dependencies | 1 (`commander`) |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/camunda-support`)
3. Ensure all tests pass (`npm test`)
4. Commit with conventional commit messages
5. Open a pull request

### Adding a New Source Platform

1. Create type definitions in `src/types/<platform>.ts`
2. Create a parser in `src/parsers/<platform>.ts`
3. Create a mapper in `src/mappers/<platform>-to-asl.ts`
4. Register the platform in `src/utils/constants.ts`
5. Add CLI routing in `src/index.ts`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `FILE_NOT_FOUND` | Input path doesn't exist | Check path; use absolute path if relative fails |
| `PARSE_ERROR` | Invalid JSON in workflow file | Validate JSON syntax; check for trailing commas |
| `VALIDATION_ERROR` | Missing required fields (name, tasks) | Ensure workflow has `name`, `tasks[]`, and `version` |
| `FILE_TOO_LARGE` | Input exceeds 10MB | Split into sub-workflows or increase limit in constants |
| `UNSUPPORTED_PLATFORM` | Platform not yet implemented | Use `supported` command to see available platforms |
| `DO_WHILE` warning | Loop construct needs manual review | Convert to Choice + loop-back pattern manually |

---

## Related

- [Netflix Conductor → Step Functions Reference Implementation](https://github.com/mopyle4/netflix-conductor-to-aws-step-function-migration)
- [Camunda → Step Functions Reference Implementation](https://github.com/mopyle4/camunda-to-aws-step-function-migration)
- [AWS Step Functions Developer Guide](https://docs.aws.amazon.com/step-functions/latest/dg/)
- [Amazon States Language Specification](https://states-language.net/spec.html)

---

## License

MIT
