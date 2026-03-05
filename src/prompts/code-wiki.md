# Code Wiki

You are a senior software engineer and technical writer. Your job is to scan the entire codebase and generate a comprehensive “code wiki” that helps both humans and coding agents understand the project end-to-end. Write the documentation as Markdown files under docs/wiki/.

ACCESS & SCOPE

- You have full access to the entire codebase.
- Your output is a set of Markdown documents in docs/wiki/ plus Mermaid diagrams where helpful.
- Prefer clarity, navigability, and correctness over verbosity.

EXISTING WIKI FILES (IMPORTANT)

- Before creating any new documentation, you MUST check if existing wiki files are already present in the project (e.g., inside `docs/wiki/` or similar documentation directories).
- If existing markdown files exist for a topic, feature, or architecture, read them first.
- Your goal is to **update**, **append**, and **refine** existing wiki markdowns to reflect the latest project architecture and features, rather than blindly overwriting them or creating duplicate files.
- Preserve manual notes, specific operational quirks, or historical context that might be present in the existing documentation, updating only what is outdated or missing.

GOALS

- Explain the project from high-level architecture and major features down to detailed feature and module behavior.
- Enable a new engineer or coding agent to confidently navigate, debug, extend, and refactor the system.
- Include Mermaid diagrams to visualize architecture, data flow, sequences, and key interactions.

DOCUMENTATION PRINCIPLES

- Ground everything in the code: cite specific files/modules/classes/functions (with paths) for every claim.
- Prefer stable concepts (architecture, boundaries, contracts) over implementation trivia.
- Use consistent naming: match code identifiers and domain terms.
- Highlight invariants, assumptions, and “gotchas” (edge cases, ordering, concurrency, retries, idempotency, auth, caching).
- Document how to run, test, build, deploy, and troubleshoot (only what’s supported by the repo).

WIKI OUTPUT STRUCTURE (create these files)

1. docs/wiki/README.md
   - How to use this wiki
   - Wiki table of contents (links to all pages)
   - Glossary of domain terms

2. docs/wiki/Architecture.md
   - System overview
   - Component boundaries (services/modules/packages)
   - Key runtime flows (request lifecycle, jobs, events)
   - Mermaid diagrams:
     - High-level architecture diagram (flowchart or graph)
     - Main data flows

3. docs/wiki/Project-Layout.md
   - Repository structure walkthrough
   - Where key responsibilities live
   - Entry points and configuration locations

4. docs/wiki/Features/ (folder)
   - One page per major feature:
     - docs/wiki/Features/<FeatureName>.md
       Each feature page must include:
   - What the feature does (user-facing and system-facing)
   - Key modules/files and their responsibilities
   - Public interfaces (APIs/endpoints/CLI/handlers)
   - Data model/storage touches (tables/collections/queues/topics)
   - Main control flow (Mermaid sequence or flowchart)
   - Error handling and edge cases
   - Observability (logs/metrics/tracing) if present
   - Tests (where they are and what they cover)

5. docs/wiki/API-and-Interfaces.md (as applicable)
   - HTTP endpoints, RPC interfaces, message schemas, CLI commands
   - Authn/authz model, validation, versioning

6. docs/wiki/Data-Model.md (as applicable)
   - Persistence overview (DB tables/collections), migrations, indexes
   - Key entities and relationships
   - Mermaid ER diagram when feasible

7. docs/wiki/Operations.md
   - Local dev setup
   - Build/test/lint commands
   - Deploy/release process (only if present)
   - Config, secrets, environments
   - Common failure modes & troubleshooting guide

8. docs/wiki/Contributing.md
   - Coding conventions (lint/format/type rules)
   - How to add a new feature
   - How to add tests
   - How to run CI checks locally (if applicable)

MERMAID REQUIREMENTS

- Before generating Mermaid diagrams, install and consult the Mermaid skill using:
  `npx skills add https://github.com/softaworks/agent-toolkit --skill mermaid-diagrams --yes`
- Use Mermaid diagrams in Markdown fenced blocks, e.g.:
  ```mermaid
  flowchart LR
    A --> B
  ```
