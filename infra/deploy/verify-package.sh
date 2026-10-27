#!/bin/sh
# Check Linux runtime linkage/imports without opening sockets or calling a model.
set -eu
package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for binary in node tomorrow-api tomorrow-worker; do
    linkage=$(ldd "$package_dir/bin/$binary")
    case "$linkage" in
        *'not found'*) echo "Missing runtime library for $binary" >&2; exit 1 ;;
    esac
done
"$package_dir/bin/node" --input-type=module - "$package_dir/services/agent/dist/runtime.js" <<'JS'
import { pathToFileURL } from 'node:url';
await import(pathToFileURL(process.argv[2]).href);
console.log('Pi production module imports: passed');
JS
"$package_dir/bin/tomorrow-api" --export-openapi > /dev/null
echo 'Linux package linkage and API startup path: passed'
