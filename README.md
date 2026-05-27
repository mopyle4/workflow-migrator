# workflow-migrator

Convert workflow definitions from Netflix Conductor (and other orchestration platforms) to AWS Step Functions Amazon States Language (ASL).

## Overview

Enterprise organizations migrating from self-hosted workflow orchestration platforms to AWS Step Functions face a manual, error-prone translation process. This CLI tool automates the structural conversion of workflow definitions, mapping platform-specific constructs to their ASL equivalents.

**What it does:**
- Parses and validates source workflow definitions
- Maps constructs to Step Functions equivalents (see [Construct Mapping](#construct-mapping))
- Converts platform-specific expressions to JsonPath
- Generates retry/catch error handling blocks
- Reports warnings for constructs requiring manual review

**What it does NOT do:**
- Migrate business logic (Lambda function code must be written separately)
- Deploy infrastructure (output is ASL JSON; deploy with CDK/SAM/CloudFormation)
- Handle in-flight executions (complete running workflows before cutover)

## Supported Platforms

| Platform | Status | Input Format | Output |
|---|---|---|---|
| Netflix Conductor | ✅ Supported | JSON DSL | ASL JSON |
| Camunda BPM | 🔜 Coming soon | BPMN 2.0 XML | ASL JSON |
| Temporal | 🔜 Planned | — | ASL JSON |

## Installation

```bash
# Install globally
npm install -g workflow-migrator

# Or run directly with npx (no install required)
npx workflow-migrator convert --from conductor --input workflow.json
```

### Prerequisites

- Node.js 20.x or later
- npm 9.x or later

## Usage

### Convert a Conductor workflow to Step Functions ASL

```bash
# Output to file
workflow-migrator convert --from conductor --input workflow.json --output state-machine.asl.json

# Output to stdout (pipe to other tools)
workflow-migrator convert --from conductor --input workflow.json > state-machine.asl.json

# Verbose mode (debug logging)
workflow-migrator -v convert --from conductor --input workflow.json --output state-machine.asl.json

# Quiet mode (errors only)
workflow-migrator -q convert --from conductor --input workflow.json --output state-machine.asl.json
```

### Validate a workflow definition

```bash
workflow-migrator validate --input workflow.json
```

### View supported platforms and construct mappings

```bash
workflow-migrator supported
```

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

**Design Patterns Used:**
- **Command Pattern** — CLI commands via Commander.js
- **Strategy Pattern** — Platform-specific parsers and mappers (extensible for Camunda, Temporal)
- **Singleton** — Logger instance shared across modules
- **Error Hierarchy** — Typed errors with codes for programmatic handling

## Error Handling

The tool uses structured error codes and exit codes:

| Exit Code | Meaning | Error Code |
|---|---|---|
| 0 | Success | — |
| 1 | User input error (bad args, file not found) | INVALID_INPUT, FILE_NOT_FOUND, UNSUPPORTED_PLATFORM |
| 2 | Invalid workflow (parse/validation failure) | PARSE_ERROR, VALIDATION_ERROR |
| 3 | Conversion failure | CONVERSION_ERROR |
| 4 | Resource limit exceeded | FILE_TOO_LARGE |
| 99 | Unexpected error | — |

## Security

- **Input validation:** File size checked before reading (max 10MB) to prevent memory exhaustion
- **No network access:** Tool operates entirely offline on local files
- **No secrets handling:** Does not read, store, or transmit credentials
- **Generated ARNs use placeholders:** Output contains `${AWS::Region}` and `${AWS::AccountId}` — never real account IDs
- **Least privilege in generated ASL:** Each Task state targets a specific Lambda function ARN, not wildcards

## Performance

- **Time complexity:** O(n) where n = total tasks (including nested branches)
- **Space complexity:** O(n) for the generated state machine
- **Input limits:** Max 10MB file size, max 500 tasks per workflow
- **No external dependencies at runtime:** Only `commander` for CLI parsing

## Development

```bash
# Clone and install
git clone git@ssh.code.aws.dev:personal_projects/alias_m/mopyle/workflow-migrator.git
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

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/camunda-support`)
3. Ensure all tests pass (`npm test`)
4. Ensure no lint errors (`npm run lint`)
5. Commit with conventional commit messages
6. Open a pull request

### Adding a New Source Platform

1. Create type definitions in `src/types/<platform>.ts`
2. Create a parser in `src/parsers/<platform>.ts`
3. Create a mapper in `src/mappers/<platform>-to-asl.ts`
4. Register the platform in `src/utils/constants.ts` (`SUPPORTED_PLATFORMS`)
5. Add the CLI routing in `src/index.ts`

## Changelog

### 0.1.0 (2026-05-18)

- Initial release
- Netflix Conductor JSON DSL → Step Functions ASL conversion
- Supports: HTTP, SIMPLE, DECISION, SWITCH, FORK_JOIN, WAIT, SUB_WORKFLOW, TERMINATE
- Expression mapping (Conductor `${}` → JsonPath `$.`)
- Structured logging with verbosity levels
- Input validation with size limits and structural checks
- Custom error hierarchy with exit codes

## Related Resources

- [Migrating from Netflix Conductor to AWS Step Functions](https://aws.amazon.com/blogs/migration-and-modernization/) — Comprehensive migration guide
- [AWS Step Functions Documentation](https://docs.aws.amazon.com/step-functions/latest/dg/)
- [Amazon States Language Specification](https://states-language.net/spec.html)
- [Netflix Conductor Documentation](https://conductor-oss.github.io/conductor/)

## License

MIT
