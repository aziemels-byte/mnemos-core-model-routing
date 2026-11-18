# MNEMOS Core model routing

This repository exports the model selection and recovery modules from the existing MNEMOS Core project at commit `cfa161c37a23b766f79164d1d2f3e2bca1b41473`. It includes provider failure classification, candidate filtering and ranking, model directive parsing, and focused tests. It is a standalone source export with no service credentials or provider configuration.

Run the baseline tests from the repository root on Linux with Node.js 22.

```sh
node --test test/*.test.mjs
```

The baseline uses test providers and makes no live model requests.
