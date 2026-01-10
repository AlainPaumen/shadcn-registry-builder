import { readFile } from "node:fs/promises";
import path from "node:path";

export type PackageInfo = {
    path: string;
    name?: string;
    version?: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
};

export async function findNearestPackageJson(
    startDir: string
): Promise<PackageInfo | null> {
    let currentDir = startDir;

    while (true) {
        const pkgPath = path.join(currentDir, "package.json");
        try {
            const file = await readFile(pkgPath, "utf8");
            const parsed = JSON.parse(file);
            return {
                path: pkgPath,
                name: parsed.name,
                version: parsed.version,
                dependencies: parsed.dependencies ?? {},
                devDependencies: parsed.devDependencies ?? {},
            };
        } catch (error) {
            if (!isFileMissing(error)) {
                throw new Error(
                    `Failed to read package.json at ${pkgPath}: ${(error as Error).message}`
                );
            }
        }

        const parent = path.dirname(currentDir);
        if (parent === currentDir) {
            break;
        }
        currentDir = parent;
    }

    return null;
}

function isFileMissing(error: unknown): error is NodeJS.ErrnoException {
    return (
        Boolean(error && typeof error === "object" && "code" in error) &&
        ["ENOENT", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
    );
}
