# CRAP attribution

CRAP (Control Room for Agentic Proxy) builds on CLIProxyAPI, maintained by
Router-For.ME and its contributors: https://github.com/router-for-me/CLIProxyAPI.
CLIProxyAPI is an independently installed external dependency. CRAP does not
vendor, build or republish its engine. The guided composition references an
official image; users obtain it directly from its maintainers.
CRAP does not claim authorship of that engine or endorsement by its maintainers
or by model providers.

The accompanying LICENSE contains the upstream MIT copyright and license notice.
Packaged CRAP images include both files under `/usr/share/doc/crap/`.

The dashboard and services also use third-party Go and JavaScript dependencies.
Their versions are recorded in the source lockfiles; release candidate artifacts
include dependency inventories. These dependencies retain their respective
licenses; the project's personal-use guidance does not relicense them.
