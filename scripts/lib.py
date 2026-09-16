"""Shared helpers for parsing GitHub Issue Forms and talking to `gh`."""
import json
import re
import subprocess

PROJECT_NAME_TO_ID = {
    "WebNext": "webnext",
    "WebNext 2.0": "webnext-2",
    "Pledge – 1.0": "pledge",
    "Pledge - 1.x": "pledge-1a",
    "EMM": "emm",
    "MyBKY (Phase 1)": "mybky-phase1",
    "myBKY 2A": "mybky-phase2",
    "myMandir 1B": "mymandir",
    "myMandir 1C": "mymandir-1c",
    "GMS 1.4": "gms",
    "SSO V2": "baps-sso",
    "SPM": "spm",
    "BKMS": "bkms",
    "MIS": "mis",
    "mySatsang – BAPS ID Integration": "mysatsang-bapsid",
}

# Maps the "Overall status" dropdown option text (lowercased) -> canonical status key.
STATUS_TEXT_TO_KEY = {
    "green": "green",
    "amber": "amber",
    "red": "red",
    "non-recoverable": "black",
}

STATUS_RANK = {"green": 0, "amber": 1, "red": 2, "black": 3}

STATUS_LABEL = {
    "green": "On Track",
    "amber": "At Risk",
    "red": "Critical",
    "black": "Non-Recoverable",
}

# GitHub renders each issue-form field as "### <label>\n\n<value>\n\n"
_HEADING_RE = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)


def run_gh(args, input_data=None):
    """Run a `gh` CLI command and return stdout. Raises on non-zero exit."""
    result = subprocess.run(
        ["gh"] + args,
        input=input_data,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"gh {' '.join(args)} failed: {result.stderr.strip()}"
        )
    return result.stdout


def parse_issue_form_body(body):
    """Parse a rendered GitHub issue-form body into {label: value}.

    GitHub renders each field as a "### Label" heading followed by the
    answer text (or "_No response_" if left blank).
    """
    fields = {}
    matches = list(_HEADING_RE.finditer(body))
    for i, m in enumerate(matches):
        label = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        value = body[start:end].strip()
        if value == "_No response_":
            value = ""
        fields[label] = value
    return fields


def lines(value):
    """Split a textarea value into a clean list of non-empty lines."""
    if not value:
        return []
    return [l.strip().lstrip("-").strip() for l in value.splitlines() if l.strip()]


def to_int(value, default=0):
    try:
        return int(str(value).strip())
    except (ValueError, TypeError):
        return default


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
