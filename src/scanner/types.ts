import type { NormalizedConfig } from "../config";
import type { PackageInfo } from "../package-info";
import type { PathMapping } from "../tsconfig-info";

export type ContentFileInfo = {
    path: string;
    basePath: string;
    directory: string;
};

export type ScanOptions = {
    packageInfo?: PackageInfo | null;
    pathMappings?: PathMapping[];
    packageRoot?: string;
    contentFiles?: ContentFileInfo[];
    contentDependencyMap?: Map<string, string[]>;
};

export type ScanContext = {
    rootPath: string;
    config: NormalizedConfig;
    options: ScanOptions;
};
