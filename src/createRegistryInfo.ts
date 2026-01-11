import path from "node:path";
import { formatFileDependencyPath } from "./index";

export function createRegistryInfo(targetPath: string, items: string[]): void {
    const folderName = path.basename(targetPath);
    const componentPath = formatFileDependencyPath(targetPath, "./");
    const info = {
        $schema: "https://ui.shadcn.com/schema/registry.json",
        name: `hoogin-${folderName}`,
        homepage: "https://hoogin.be",
        author: "Alain Paumen",
        categorie: [`${folderName}`],
        path: componentPath,
        items: items.map((item) => ({
            name: item,
            description: "",
            type: "registry:component",
            path: formatItemPath(item, componentPath),
            categories: []
        })),
    };

    console.log(JSON.stringify(info, null, 2));
}

function formatItemPath(item: string, componentPath: string): string {
    if (!item.includes("/")) {
        return `./${componentPath}`;
    }

    const lastSlashIndex = item.lastIndexOf("/");
    return lastSlashIndex === -1 ? `./${componentPath}` : `./${item.slice(0, lastSlashIndex)}`;
}
