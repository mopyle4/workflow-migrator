---
inclusion: auto
description: Core engineering standards for the workflow-migrator CLI. Enforces Well-Architected, design patterns, performance, security, clean code, and observability.
---

# Engineering Standards — workflow-migrator

These standards apply to ALL code in this repository. They encode the 6 non-negotiable quality pillars for this project.

---

## 1. AWS Well-Architected Framework

This is a CLI tool that generates AWS infrastructure definitions (ASL). The generated output must follow Well-Architected principles:

- **Operational Excellence:** Generated ASL includes CloudWatch logging configuration comments and X-Ray tracing hints
- **Security:** Generated Task states include Catch blocks by default. Generated Lambda ARNs use `${AWS::Region}:${AWS::AccountId}` (not wildcards). Never generate `resources: ['*']`
- **Reliability:** Generated states include Retry with exponential backoff by default. Generated workflows include error handling paths (HandleError Fail state)
- **Performance:** Parser uses streaming/chunked reading for large files. Lookup maps use O(1) data structures (Map/Set, not Array.find)
- **Cost Optimization:** Generated ASL uses Standard workflows by default (not Express) unless the source workflow is short-running

---

## 2. Design Patterns

Apply these patterns consistently:

- **Strategy Pattern:** Platform-specific parsers and mappers are interchangeable strategies selected by the `--from` flag
- **Command Pattern:** CLI commands (convert, validate, supported) are independent command handlers via Commander.js
- **Visitor/Walker Pattern:** BPMN graph traversal uses a recursive walker that visits each element once
- **Builder Pattern:** ASL state machine is built incrementally as the graph is walked
- **Factory Pattern:** Error classes use a hierarchy with factory-like constructors (ParseError, ValidationError, ConversionError)
- **Singleton Pattern:** Logger instance is module-level singleton, configured once at startup

When adding new functionality, identify which pattern applies BEFORE writing code.

---

## 3. Performance (Time & Space Complexity)

- **Parsing:** O(n) where n = file size. Single-pass XML/JSON parsing. No re-reading the file.
- **Graph traversal:** O(V + E) where V = elements, E = sequence flows. Use visited set to prevent cycles.
- **Lookups:** All element/flow lookups use Map<string, T> for O(1) access. Never use Array.find() for repeated lookups.
- **Memory:** Don't load the entire AST into memory twice. Parse once, transform in-place or stream.
- **File I/O:** Validate file size BEFORE reading (fail fast). Read once, parse once.
- **String operations:** Use template literals over concatenation. Avoid regex compilation inside loops — compile once at module level.

---

## 4. Security (Least Privilege)

- **Input validation:** Validate ALL external input before processing (file paths, CLI args, XML content)
- **File size limits:** Enforce MAX_INPUT_FILE_SIZE_BYTES before reading any file
- **No code execution:** Never eval() or dynamically execute content from input files
- **XXE prevention:** Use XML parsers that do NOT resolve external entities (fast-xml-parser is safe by default)
- **Path traversal:** Resolve file paths with path.resolve() — don't pass raw user input to fs operations
- **Generated output:** Never include secrets, credentials, or real account IDs in generated ASL. Use CloudFormation pseudo-parameters (`${AWS::Region}`, `${AWS::AccountId}`)
- **Dependencies:** Pin exact versions. Audit for vulnerabilities before adding.

---

## 5. Clean Code (DRY, SOLID)

### DRY (Don't Repeat Yourself)
- Shared utilities go in `src/utils/` — never duplicate logic across parsers or mappers
- Common ASL patterns (retry config, catch config, state name generation) are extracted into reusable functions
- Type definitions are centralized in `src/types/` — never inline type literals

### SOLID
- **Single Responsibility:** Each file has ONE job. Parsers parse. Mappers map. Utils provide cross-cutting concerns.
- **Open/Closed:** New platforms are added by creating new parser + mapper files. Existing code is not modified.
- **Liskov Substitution:** All parsers return a platform-specific type. All mappers accept that type and return ConversionResult.
- **Interface Segregation:** ConversionResult is the shared interface between mappers and the CLI. Parsers don't know about ASL.
- **Dependency Inversion:** The CLI depends on abstractions (function signatures), not concrete implementations. Platform selection is a runtime decision.

### Naming
- Files: kebab-case (`conductor-to-asl.ts`)
- Functions: camelCase, verb-first (`parseConductorWorkflow`, `convertCamundaToASL`)
- Types/Interfaces: PascalCase (`ConductorWorkflow`, `ASLStateMachine`)
- Constants: UPPER_SNAKE_CASE (`MAX_INPUT_FILE_SIZE_BYTES`)

### Function Design
- Max 40 lines per function (extract helpers when exceeding)
- Max 3 parameters (use options object for more)
- Pure functions where possible (no side effects except I/O at boundaries)
- Early returns for validation (guard clauses at top)

---

## 6. Logging, Error Handling, and Retry

### Logging
- Use the structured logger (`src/utils/logger.ts`) — never raw `console.log`
- Log at appropriate levels: DEBUG for internal state, INFO for user-facing progress, WARN for non-fatal issues, ERROR for failures
- Include context objects with structured data (not string interpolation)
- Never log file contents, secrets, or PII

### Error Handling
- Use the custom error hierarchy (`ParseError`, `ValidationError`, `ConversionError`)
- Every error includes: error code, human-readable message, and context object
- Fail fast: validate inputs at function entry, not mid-execution
- Never swallow errors silently — always log or re-throw
- CLI exit codes are deterministic and documented (1 = input error, 2 = invalid workflow, 3 = conversion failure, 4 = resource limit)

### Retry (in generated ASL)
- ALL generated Task states include a Retry block with exponential backoff
- Default: `ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 2, BackoffRate: 2.0`
- If the source workflow has explicit retry config, map it to ASL Retry (preserve the original intent)
- ALL generated Task states include a Catch block routing to HandleError

---

## Testing Requirements

- **Unit tests:** Every public function has tests covering happy path, edge cases, and error paths
- **Integration tests:** End-to-end conversion of real BPMN/Conductor files produces valid ASL
- **Coverage target:** 90%+ line coverage
- **Test naming:** `describe('functionName')` → `it('does X when Y')` pattern
- **Mocking:** Mock only I/O boundaries (file system). Never mock internal functions.
- **Assertions:** Use specific matchers (`toEqual`, `toContain`, `toThrow`) — never generic `toBeTruthy`
