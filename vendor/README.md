# Vendored dependencies

`dsh-root-temp-guard` must work when it is loaded from a plain directory
(desktop profile `insert` by absolute path) where no `node_modules` exists, so
the two packages below are vendored instead of declared as npm dependencies.

| Directory | Upstream package | Version | License |
| --- | --- | --- | --- |
| `schemastery/` | [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) | 3.19.0 | MIT (see `schemastery/LICENSE`) |
| `cosmokit/` | [`@deepseek-ai/cosmokit`](https://www.npmjs.com/package/@deepseek-ai/cosmokit) | 1.9.0 | MIT (see `cosmokit/LICENSE`) |

Only changes: `schemastery/index.mjs` imports `../cosmokit/index.mjs` instead of
the bare `@deepseek-ai/cosmokit` specifier; `cosmokit/index.js` was renamed to
`index.mjs`. No code was modified otherwise.

The vendored schemastery copy defines the plugin's `Config` schema (a
schemastery schema whose root is `.volatile()`, which is what lets DSH's
settings forms edit the configuration live). Schemastery's volatile marker uses
`Symbol.for("cosmokit.volatile.write")`, so the copy interoperates with the
schemastery/cosmokit copies DSH itself loads.
