# ShadCN Registry Builder

A Node.js utility that recursively scans a directory for JavaScript/TypeScript files and outputs a JSON tree describing directories, files, and import statements.

## Development

```bash
npm install
npm run build
```

## Running the scanner

```bash
# Scan a directory (path is required)
npm start -- /path/to/project
```

The CLI exits with an error if no path is supplied or if the path does not resolve to an existing directory.

### Configuration

You can provide a `shadcn-registry-builder.json` file in the directory you scan (defaults live at the project root) with:

```json
{
  "allowed_extensions": [".js", ".jsx", ".ts", ".tsx"],
  "skip_directories": ["node_modules", ".git", "dist", ".dist"]
}
```

Both lists are optional; missing values fall back to the defaults above. Extensions are normalized (case-insensitive, dot-prefixed) and directory names are matched case-insensitively.

### Output format

The CLI prints a JSON structure to stdout matching:

- `type`: `directory` or `file`
- `name` / `path`: identifiers relative to the scanned root
- `children`: nested nodes for directories
- `imports`: list of `{ line, statement }` for each import inside a file
- `meta`: file metadata (size, modified timestamp) ready for future extensions
