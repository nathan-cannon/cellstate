# Security Policy

## Supported Versions

CellState is in early development. Security fixes will be applied to the latest release only.

## Reporting a Vulnerability

If you find a security vulnerability, please email natecannon@cellstate.dev instead of opening a public issue.

I'll try to acknowledge reports within 48 hours and provide a fix or mitigation plan within 7 days for confirmed issues.

## Scope

CellState processes terminal escape sequences and renders content to the terminal. Relevant security concerns include terminal escape injection, denial of service through malformed input, and unexpected code execution via ANSI/OSC sequences.
