# Development and release workflow

Ditto changes follow **`dev` → validation → `main` → package release**.

- Start development on `dev`. Code, documentation, version changes and release preparation must land on `dev` first.
- If an isolated feature branch is needed, create it from `dev` with the `dev/` prefix and merge it back into `dev`.
- Validate the changes on `dev` before merging into `main`. Run the relevant code checks for implementation changes and documentation builds for site changes; workflow-only instructions need a diff review.
- Advance `main` by merging the validated `dev` branch. Do not commit development changes directly on `main` or bypass `dev` when targeting `main`.
- Publish packages from the validated release on `main` after its code, version and documentation are synchronized.
- Return the local development checkout to `dev` after completing a merge or release.
