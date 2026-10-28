# Final verification results

Recorded on 2026-10-28 using Node 22.22.3 and pnpm 12.10.1. These are local runs against synthetic data.

| Command or surface         | Result                                                                     | Evidence                                                                  |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Frozen offline install     | Pass                                                                       | [install log](frozen-install.log)                                         |
| Complete automated suite   | 183 passed, 0 failed                                                       | [test log](tests.log)                                                     |
| Typecheck                  | Pass, plugins loaded                                                       | [typecheck log](typecheck.log)                                            |
| ESLint                     | 0 errors, one preexisting optional-prop warning                            | [lint log](lint.log)                                                      |
| Production build           | Pass                                                                       | [build log](build.log)                                                    |
| Isolated production HTTP   | Bootstrap, privacy, status, metadata, settings and normal EPUB upload pass | [API log](production-api.log)                                             |
| Native Chrome              | Reader sandbox in both modes, rapid-exit CFI and keyboard controls pass    | [browser log](browser.log), [structured results](../browser-results.json) |
| Actual Nitro restart       | Conflicting uncommitted move preserves both files and permits requests     | [restart log](startup.log)                                                |
| Fresh migrations, repeated | Pass on disposable SQLite                                                  | [migration log](migrations.log)                                           |
| Dependency scan            | One low deepmerge tooling advisory remains; no patched version listed      | [registry result](dependency-audit.json)                                  |

Docker execution, real Unraid/network-filesystem behavior, power loss, screen readers, mobile devices and representative production load remain unverified locally. CI performs the production container build. These logs do not certify deployment behavior beyond the exercised synthetic cases.
