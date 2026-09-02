#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="${ROOT_DIR}/.github/workflows/cla.yml"
CODEOWNERS="${ROOT_DIR}/.github/CODEOWNERS"
FIXTURE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/fixtures/cla-allowlist-aziz.json"
CONCURRENCY_FIXTURE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/fixtures/cla-concurrency-events.json"
ACTION_SHA='212a0f2dd659b24b48a30ba35966e06dc41736af'

command -v jq >/dev/null
command -v ruby >/dev/null
[[ -f "${WORKFLOW}" && -f "${FIXTURE}" && -f "${CONCURRENCY_FIXTURE}" && -f "${CODEOWNERS}" ]]
# The action reads and writes the protected cla-signatures branch. A second
# ledger on the default branch would be a writable, unauthoritative copy.
[[ ! -e "${ROOT_DIR}/signatures/version2/cla.json" ]]

refs="$(grep -oE "manaflow-ai/cla-github-action@[0-9a-f]{40}" "${WORKFLOW}" | sort -u)"
[[ "${refs}" == "manaflow-ai/cla-github-action@${ACTION_SHA}" ]]
[[ "$(sed -n '1p' "${WORKFLOW}")" == 'name: "CLA Assistant v3"' ]]
[[ "$(grep -Ec '^[[:space:]]+branch: "cla-signatures"$' "${WORKFLOW}")" == 3 ]]

# Parse job permissions and event lanes as data, so a formatting change
# cannot hide a missing write permission or reintroduce a lossy per-PR queue.
ruby - "${WORKFLOW}" "${CONCURRENCY_FIXTURE}" <<'RUBY'
require "json"
require "yaml"

workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
fixture = JSON.parse(File.read(ARGV.fetch(1)))
jobs = workflow.fetch("jobs")

admission = jobs.fetch("CLACommentGate")
writer = jobs.fetch("CLALedgerWriter")
rerun = jobs.fetch("RerunFailedCLA")
lock = jobs.fetch("LockMergedPullRequest")
abort "required check does not use the stable v3 name" unless jobs.fetch("CLAAssistant").fetch("name") == "CLA Assistant v3"
groups = {
  "CLACommentGate" => admission.fetch("concurrency").fetch("group"),
  "CLALedgerWriter" => writer.fetch("concurrency").fetch("group"),
  "RerunFailedCLA" => rerun.fetch("concurrency").fetch("group"),
  "LockMergedPullRequest" => lock.fetch("concurrency").fetch("group")
}
groups.each do |job_name, group|
  abort "#{job_name} concurrency group is not scoped to a workflow attempt" unless
    group.include?("${{ github.run_id }}") && group.include?("${{ github.run_attempt }}")
  abort "#{job_name} concurrency group still uses a PR queue" if
    group.include?("github.event.pull_request.number") || group.include?("github.event.issue.number")
end

events = fixture.fetch("events")
abort "concurrency fixture must contain at least two events" unless events.length >= 2
events.each do |event|
  %w[repository run_id run_attempt pull_request_number comment_id].each do |key|
    abort "concurrency fixture event is missing #{key}" unless event.key?(key)
  end
  abort "concurrency fixture run_id is invalid" unless event.fetch("run_id").is_a?(Integer) && event.fetch("run_id") > 0
  abort "concurrency fixture run_attempt is invalid" unless event.fetch("run_attempt").is_a?(Integer) && event.fetch("run_attempt") > 0
end

render_group = lambda do |template, event|
  template
    .gsub("${{ github.repository }}", event.fetch("repository"))
    .gsub("${{ github.run_id }}", event.fetch("run_id").to_s)
    .gsub("${{ github.run_attempt }}", event.fetch("run_attempt").to_s)
end
groups.each do |job_name, template|
  rendered = events.map { |event| render_group.call(template, event) }
  abort "#{job_name} concurrency group drops distinct workflow events" unless rendered.uniq.length == rendered.length
end

writer_permissions = writer.fetch("permissions")
abort "writer permissions are too broad or incomplete" unless writer_permissions == {
  "contents" => "write", "issues" => "write", "pull-requests" => "write"
}
lock_permissions = lock.fetch("permissions")
abort "lock permissions are too broad or incomplete" unless lock_permissions == {
  "contents" => "read", "issues" => "write", "pull-requests" => "write"
}
rerun_permissions = rerun.fetch("permissions")
abort "rerun permissions are too broad or incomplete" unless rerun_permissions == {
  "actions" => "write", "checks" => "read", "contents" => "read",
  "issues" => "read", "pull-requests" => "read"
}
RUBY

for path in '.github/workflows/cla.yml' '.github/scripts/' 'signatures/' 'CLA.md'; do
  grep -Eq "^${path//\//\\/}[[:space:]]+@austinywang[[:space:]]+@azooz2003-bit$" "${CODEOWNERS}"
done

# The canary models the maintained action's opener-only numeric exemptions. It
# proves a matching unknown opener remains eligible, an unknown opener with no
# authored commit is rejected, and Aziz's authenticated mismatch is exempt. It
# never signs a CLA or writes repository state.
allowlist_values="$(grep -E 'allowlist-ids:' "${WORKFLOW}" | grep -oE '[0-9]{1,20}(,[0-9]{1,20})+' | sort -u)"
[[ "${allowlist_values}" == '38676809,67667005' ]]
allowlist="${allowlist_values}"
is_allowlisted_opener() {
  case ",${allowlist}," in
    *,"$1",*) return 0 ;;
    *) return 1 ;;
  esac
}
opener_authorship_allowed() {
  local opener_id="$1"
  local authored="$2"
  [[ "${authored}" == true ]] || is_allowlisted_opener "${opener_id}"
}
aziz_id="$(jq -er '.pull_request.user.id' "${FIXTURE}")"
matching_untrusted_id="$(jq -er '.matching_untrusted_opener.id' "${FIXTURE}")"
untrusted_id="$(jq -er '.untrusted_opener.id' "${FIXTURE}")"
# An opener whose authenticated identity is present in the commit author set
# can sign even when it is not in the exemption list.
if ! opener_authorship_allowed "${matching_untrusted_id}" true; then
  echo "unknown authored opener was incorrectly rejected" >&2
  exit 1
fi
# With the opener-authorship guard enabled, an unknown identity without an
# authored commit is rejected. The allowlist is not a general signer gate.
if opener_authorship_allowed "${untrusted_id}" false; then
  echo "unknown un-authored opener was incorrectly exempted" >&2
  exit 1
fi
# Austin/Aziz are the only documented exemptions for an authenticated mismatch.
if ! opener_authorship_allowed "${aziz_id}" false; then
  echo "Aziz's documented opener exemption was rejected" >&2
  exit 1
fi

echo "CLA v3 policy contract and Aziz opener canary passed"
