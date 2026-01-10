export type PackageReference = {
    name: string;
    version?: string;
    type: "dependency" | "devDependency" | string;
};

export type ImportEntry = {
    line: number;
    statement: string;
    moduleSpecifier?: string;
    fileDependency?: string;
    dependency?: PackageReference;
    devDependency?: PackageReference;
    registryDependency?: PackageReference;
    pathAlias?: string;
    resolvedPaths?: string[];
};

export type FileMeta = {
    size: number;
    modifiedAt: string;
    importCount?: number;
};

interface BaseNode {
    type: "file" | "directory";
    name: string;
    path: string;
}

export interface FileNode extends BaseNode {
    type: "file";
    imports: ImportEntry[];
    meta: FileMeta;
}

export interface DirectoryNode extends BaseNode {
    type: "directory";
    children: TreeNode[];
}

export type TreeNode = FileNode | DirectoryNode;
