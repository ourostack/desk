### Fixed

- Factory capture keeps resumed Claude workers' execution periods separate when the host marks coordinator messages or completion notifications as meta inputs. Stopped gaps no longer become continuous work, and those inputs do not become human attention. The ordinary sweep re-derives available historical transcripts automatically.
