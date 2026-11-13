### Session start no longer prints the AGENTS.md a Copilot host already loaded

Boot printed the desk's `AGENTS.md` in full, and Copilot had already put that same file into the model's instructions, so every later model call carried the rules twice. A boot run by Copilot from the folder that holds the desk's `AGENTS.md` now prints one line saying the host loaded it, and the person's own `AGENTS.md` still prints in full. A boot from any other folder or host prints the file as before, and `--json` still carries it, with `agents_md_in_host_instructions` saying whether the text was left out.
