---
description: "MiMo defaults shipped with the Nexgent browser and headless application."
kind: "package-bundle"
---

# @nexgent/application

English | [中文](README.zh.md)

## Summary

The shipped `nexgent` and `nexgent-run` profiles complete general tasks using MiMo-V2.6-Pro, native tools and durable sessions. This private application layer supplies their default provider, persona, local request ledger and telemetry policy. It is built with the application's source and needs no separate installation into an external DSH deployment. Independent candidate selection and architecture evolution are not yet part of these profiles.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The application's shipped profiles include this layer after the inherited base and browser or headless layer. The application's root `start.ps1` and `run.ps1` select those profiles. Credentials come from `NEXGENT_API_KEY` through the native credential service. Endpoint overrides belong in the native model configuration. Architecture graphs run through the native workflow tool and are saved under the project data directory. New Sessions can explicitly execute a saved `architectureVersion`; this does not select or adopt it automatically.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) replaces defaults by row identity. The inherited Agent owns model execution, filesystem tools and persistence; this layer adds no Python executor, model gateway or per-task SDK carrier. Profile overrides remain available through the native configuration surface. No invariant companion is published because this observer owns no cross-service mutable relation; inserted row owners retain their invariants. [Profile loading](../../boot/app-boot/README.md) and the [base runtime](../base/README.md) own composition and execution.

The application's `ExecutionLedger` observes the native `llm/stream` waterfall, including members and auxiliary calls. Each composition owns one exclusive JSONL file under `execution-ledgers` in the application data directory, synchronizes each append and closes the file on unload. Start and settlement records preserve route, supplied Session identity, purpose, termination and the last reported usage sample. Prompt text, credentials and provider error text are excluded. Missing or invalid usage stays explicit; reasoning is an output subset and is not added again. Shutdown records report storage failures. The reader rejects malformed records, duplicate settlements, incomplete lines and records after shutdown. Absent shutdown or unfinished requests prevent complete-observation claims. This sidecar adds no released Session event or generation.

</details>

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's package, which owns that row's model-facing behavior.

#### KV Cache effect

The application persona changes the system prefix. Inherited prompt and provider packages own request assembly and caching; this layer does not measure cache savings.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Python evaluator, selection, guard and version adoption do not yet protect native sessions. Independent trials and candidate adoption remain migration work.
- Stream observations include replay and middleware responses; adapter-internal transport retries are not separately observed. The local, unsigned ledger is not an invoice or an independent selection guard. Storage warnings, missing buckets and incomplete lifecycles prevent corresponding accounting claims.
- The application retains platform confinement requirements; Windows ACL errors remain tool failures rather than granting unrestricted execution.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
