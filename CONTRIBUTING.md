# Contributing

Issues and pull requests are welcome.

- **Setup:** install [Bun](https://bun.sh) 1.3.5 or later, then run `bun install`.
- **Before sending a change**, run the same checks CI runs on Linux x64, Linux arm64 and macOS:
  ```sh
  bun test
  bun run typecheck
  bun run check-headers
  ```
- **License header:** new source files start with the header every file in `src/` has.
- **Design changes:** [DESIGN.md](DESIGN.md) explains the decisions (for example the fixed terminal size and the single query responder). Update it in the same pull request when a change affects them.
- **License:** by contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE) (section 5).
- **Security issues:** don't open a public issue; see [SECURITY.md](SECURITY.md).
