# Read-only agent evaluations

Build tests with `bun run test`, then configure the agent client's STDIO command as `node` with the absolute `.cache/tests/fixture-server.mjs` path. This development-only server uses immutable synthetic data, owns no signing credential, and makes no external calls. Run each question in a fresh conversation, without exposing `eval.xml` answers to the agent.

`eval.xml` contains ten independent questions with deterministic answers, covering account analysis, market capabilities, backend pagination, exact IDs, fills and unresolved intent. Store client/model/version, question, tool transcript and exact-answer outcome outside the repository when executing it. Never substitute live accounts for these fixtures.
