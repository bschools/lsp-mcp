import * as fs from "node:fs";
import * as path from "node:path";
function hasTsConfigWithCompilerOptions(filePath) {
    try {
        const content = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(content);
        return (typeof parsed === "object" &&
            parsed !== null &&
            "compilerOptions" in parsed &&
            typeof parsed.compilerOptions === "object");
    }
    catch {
        return false;
    }
}
export function detectWorkspaceRoot(filePath) {
    const dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    let current = path.resolve(dir);
    let tsConfigWithCompilerOptions = null;
    let jsConfigDir = null;
    let packageJsonDir = null;
    for (;;) {
        // Check nearest tsconfig.json with compilerOptions
        if (tsConfigWithCompilerOptions === null) {
            const tsconfig = path.join(current, "tsconfig.json");
            if (fs.existsSync(tsconfig) && hasTsConfigWithCompilerOptions(tsconfig)) {
                tsConfigWithCompilerOptions = current;
            }
        }
        // Check nearest jsconfig.json
        if (jsConfigDir === null) {
            const jsconfig = path.join(current, "jsconfig.json");
            if (fs.existsSync(jsconfig)) {
                jsConfigDir = current;
            }
        }
        // Check nearest package.json
        if (packageJsonDir === null) {
            const pkg = path.join(current, "package.json");
            if (fs.existsSync(pkg)) {
                packageJsonDir = current;
            }
        }
        const parent = path.dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return (tsConfigWithCompilerOptions ??
        jsConfigDir ??
        packageJsonDir ??
        path.dirname(path.resolve(filePath)));
}
//# sourceMappingURL=detect.js.map