# OpenFOAM cavity smoke plugin

This optional package registers `nexgent.domains:openfoam_cavity` and
`nexgent.task_benchmarks:openfoam_cavity`. Core contains no CFD-specific code and
does not import this package. Install it with:

```text
python -m pip install -e benchmarks/openfoam
```

The first release deliberately supports one frozen slice: `split="smoke"`,
`seed=0`, scenario `cavity_re10`. It copies the official OpenFOAM Foundation 8
`incompressible/icoFoam/cavity/cavity` tutorial into the task-scoped managed
workspace under `.nexgent/tool-workspaces/openfoam/<root-task>/jobs/<digest>`.
The framework workspace API supplies that root; task or model text never supplies
a filesystem path.

The native backend requires `WM_PROJECT=OpenFOAM`, `WM_PROJECT_VERSION=8`,
`FOAM_TUTORIALS`, and `blockMesh`, `checkMesh`, and `icoFoam` on the host PATH.
On Windows, discovery can use only the fixed `Ubuntu-20.04` WSL distribution,
`/opt/openfoam8/etc/bashrc`, and official `/opt/openfoam8/tutorials` path. The WSL
probe, template copy, and solver launch scripts are plugin constants. The only
runtime argument is a plugin-generated and validated `/mnt/<drive>/...` managed
case path; no agent-provided command or shell fragment is accepted. Importing the
package does not start WSL or a solver.

The workflow is:

1. `openfoam.probe_environment({})` safely reports availability.
2. `openfoam.prepare_cavity({"spec_ref": ...})` validates the exact frozen spec,
   bounded-copies regular template files, and publishes a case receipt.
3. `openfoam.run_cavity({"case_ref": ...})` runs fixed `blockMesh`, `checkMesh`,
   and `icoFoam` argv with a 60-second timeout and 64 KiB retained output per
   process. Stop requests terminate and reap the child. The tool parses mesh,
   solver, and latest `U`/`p` field evidence and returns `run_manifest` and
   `verification_report` documents with content digests, provenance, and resource
   receipts.
4. The agent publishes those two documents and calls
   `openfoam.validate_delivery` on the exact final artifact refs. Validation binds
   them to the managed `run.json` receipt.

The independent evaluator receives frozen inputs, final resolved deliverables,
and host-recorded tool receipts. It accepts only an available probe, a matching
preparation, an exact real `run_cavity` result, passed public smoke checks, and a
matching final validation receipt. Candidate-authored receipt-shaped JSON is not
execution evidence.

`controlled_failure=True` enables a synthetic recovery contract. The first
durably admitted `prepare_cavity` call returns `status="contract_rejected"` with
`reason="synthetic_once_only_rejection"`; retrying the unchanged frozen spec prepares
normally. Acceptance requires exactly one such host receipt and never relaxes the
real solver or delivery requirements.

This benchmark establishes only that a small official case can be prepared,
executed, parsed, and receipt-bound. It does not claim numerical accuracy, grid
convergence, performance, coverage of other CFD scenarios, reliability across
installations, or RSI.
