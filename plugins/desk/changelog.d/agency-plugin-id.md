### Desk has a fixed Agency plugin ID

[`agency.json`](agency.json) now carries `pluginId` `006b58c2-230c-47b1-831a-a1cc2fd10ef9`. Agency treats installs that share a plugin ID as one plugin, so Desk from the coming Agency marketplace listing and Desk from `github:ourostack/desk:plugins/desk@main` (installed directly, or as a dependency of MS Desk or cit) load as one Desk instead of two.
