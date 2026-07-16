#!/usr/bin/env python3
"""One-off helper: register fan-orchestrator 7.7.0 in FAN Store index.json.
Safe to delete after running.
"""
import json
import sys
from pathlib import Path

INDEX_PATH = Path("/c/Users/User/fan-store/index.json")
TARBALL_NAME = "fan-orchestrator-7.7.0.tar.gz"
SHA256_HASH = "25e76541ed97c1a8a43369d5120ca3f85248c3c194fabea2e417482e0f362372"
DESCRIPTION = (
    "FAN orchestrator v7.7.0 — MCP integration: 31/32 roadmap functions "
    "(coordinator MCP, worker proxy, profile filtering, /mcp status, OAuth, "
    "auto-restart, structuredContent, progress, logging) + 10 critical bug "
    "fixes (server ID spoofing, SSRF, ReDoS, permission gate broken, list_changed "
    "double-fetch) + e2e tests + lint cleanup. Workers stay lightweight via "
    "RemoteProxyTool. JSON-RPC 2.0 over stdio/Streamable HTTP. MCP SDK v1.29."
)
DOWNLOAD_URL = f"https://fan.sea-agents.ru/fan-store/packages/{TARBALL_NAME}"


def main() -> int:
    data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))

    new_entry = {
        "name": "fan-orchestrator",
        "version": "7.7.0",
        "type": "extension",
        "description": DESCRIPTION,
        "author": "FAN Team",
        "downloadUrl": DOWNLOAD_URL,
        "hash": f"sha256:{SHA256_HASH}",
    }

    packages = data["packages"]
    if any(p["version"] == "7.7.0" and p["downloadUrl"] == new_entry["downloadUrl"] for p in packages):
        print("fan-orchestrator 7.7.0 already in index.json")
        return 0

    for i, p in enumerate(packages):
        if p.get("name") == "fan-orchestrator":
            packages.insert(i, new_entry)
            break
    else:
        packages.append(new_entry)

    INDEX_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8"
    )
    print(f"OK: appended fan-orchestrator 7.7.0 (sha256: {SHA256_HASH[:16]}...)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
