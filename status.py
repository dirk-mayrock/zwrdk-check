#!/usr/bin/env python3
"""ZWRD-K Wachplan-Monitor – Status-Check
Aufruf: python3 status.py
"""
import subprocess, re

REPO = "dirk-mayrock/zwrdk-check"

print("\n=== ZWRD-K Wachplan-Monitor ===\n")

# Letzte Läufe + neueste Run-ID holen
print("--- Letzte Läufe ---")
result = subprocess.run(
    ["gh", "run", "list", "--repo", REPO, "--limit", "5", "--json", "databaseId,status,conclusion,displayTitle,createdAt,updatedAt"],
    capture_output=True, text=True
)

import json
runs = json.loads(result.stdout)
for r in runs:
    status = r.get("conclusion") or r.get("status")
    print(f"  {status:12}  {r['displayTitle']}  {r['createdAt']}  (ID: {r['databaseId']})")

if not runs:
    print("  Keine Läufe gefunden.")
    exit(0)

latest_id = str(runs[0]["databaseId"])

# Log des letzten Laufs
print(f"\n--- Ergebnis des letzten Laufs (ID: {latest_id}) ---")
result = subprocess.run(
    ["gh", "run", "view", latest_id, "--repo", REPO, "--log"],
    capture_output=True, text=True
)

keywords = [
    "ZWRD-K Wachplan-Check ===",
    "Zeit:",
    "Login erfolgreich",
    "Prüfe:",
    "Keine Planung",
    "Plan vorhanden",
    "Zusammenfassung",
    "Gesamt geprüft",
    "Fehler:",
    "Neu verfügbar",
    "E-Mail gesendet",
    "Keine neuen Wachpläne",
    "State gespeichert",
]

for line in result.stdout.splitlines():
    parts = line.split('\t')
    text = parts[-1] if len(parts) >= 3 else line
    text = re.sub(r'^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+', '', text)
    if any(kw in text for kw in keywords):
        print(" ", text)

print("\n--- Aktionen ---")
print(f"  Testlauf:  gh workflow run check-wachplan.yml --repo {REPO} --field dry_run=true")
print(f"  Echtlauf:  gh workflow run check-wachplan.yml --repo {REPO} --field dry_run=false\n")
