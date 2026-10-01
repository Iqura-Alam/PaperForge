# PaperForge Codex environment

## Storage boundary

- Keep project tools, caches, downloads, and generated setup state on the E drive inside this repository.
- Do not install project dependencies or write project configuration to `C:\`, `%USERPROFILE%`, `%LOCALAPPDATA%`, or the global Codex home.
- If a required operation cannot avoid a C-drive write, stop and ask the user first.
- Use `.codex-local/` for local runtimes, caches, cloned references, and temporary setup files.

## Project-local tools

- Spec Kit: `.codex-local/bin/specify.exe`
- No Mistakes: `.agents/skills/no-mistakes/bin/no-mistakes.exe`
- Impeccable engine: `.agents/skills/impeccable/scripts/impeccable.cmd`
- Activate the E-only command environment with `.\Use-PaperForgeCodex.ps1`.

## Installed workflows

- Use the `speckit-*` skills for spec-driven development.
- Use `frontend-design` and `impeccable` for UI work.
- Use `design-reference-library` to select examples from the local `awesome-design-md` collection.
- Use the ECC-derived quality skills for architecture, testing, security, repository inspection, and verification.
- Use `no-mistakes` for repository rule initialization only after this folder is a Git repository with the intended remote.
- Use Caveman skills only when the user requests Caveman mode or unusually terse output.

