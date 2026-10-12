# s1-auto-router

`s1-auto-router` is a Claude Code plugin.
It uses a local Decider model to select a model and an effort level for subagent tasks.
The Decider model operates on your Mac.
The Claude Code subagents use Claude models through your Claude Code account.

The plugin writes subagent prompt data to a local log.
[Data storage](#data-storage) explains the log contents and removal procedure.

## Requirements

Make sure that you have:

- A Mac with Apple silicon
- Claude Code terminal version 2.1.287 or newer, with [mods active](https://code.claude.com/docs/en/plugins/mods)
- [Git](https://git-scm.com/downloads)
- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Python 3 available as `python3`
- An internet connection for installation and the first model download.

`uv` prepares a Python 3.13 environment for only this plugin.
The default Decider model is `2B`.
The model files use approximately 1 GB of disk space.
The Python environment uses more space.

The initial model tests used an Apple M4 with 16 GB of memory.
This is a test system, not a minimum memory specification.
[Evaluation results](eval/README.md) give more information.

## Installation

1. Add the Git repository as a plugin marketplace in your terminal.

   ```sh
   claude plugin marketplace add https://github.com/thomas-dudoux/s1-auto-router.git
   ```

2. Install the plugin for your user account.

   ```sh
   claude plugin install s1-auto-router@s1-auto-router --scope user
   ```

3. Start a new Claude Code session in your project.

   ```sh
   claude
   ```

4. At the Claude Code prompt, enter the setup command.

   ```text
   /s1-setup
   ```

Setup installs the Python dependencies, downloads the model if necessary, and starts the local daemon.
The daemon is a background process that answers requests from the plugin.
Setup then sends a test request to the daemon.
After a correct test, setup shows this message:

```text
S1 ready: decider-2b-v11; smoke request passed.
```

The message can include more instructions.
This test examines the local model.
The next procedure examines a subagent task.

## First routing test

Routing means the selection of a model and an effort level for a subagent task.

1. Give Claude Code this assignment.

   ```text
   Use one Explore subagent to list the files in this project.
   Do not set a model or an effort value on the Agent call.
   ```

2. Examine the routing message in the terminal.

   ```text
   S1 → haiku · low
   ```

The message above is an example.
The selected values can be different.
The plugin can keep the initial value if the Decider answer has low confidence.

3. If the terminal does not show a routing message, examine the last decision in a second terminal.

   ```sh
   tail -n 1 ~/.cache/s1-auto-router/decisions.jsonl
   ```

The `applied` field shows the values that the plugin changed.
The `reasons` field explains a skipped selection or an error.
[Troubleshooting](#troubleshooting) gives the next checks.

## Routing behavior

The default rules select `haiku`, `sonnet`, or `opus` for the model.
They select `low`, `medium`, or `high` for the effort level.
An explicit value is a value in the Agent call or the agent definition.
The plugin keeps explicit model and effort values.
A request in ordinary prompt text is not an explicit value.

The parent is the agent that starts the subagent.
By default, the plugin does not select values above the parent's known model and effort levels.
This limit is the parent ceiling.
The ceiling applies only to values that the plugin selects.

If a request fails, the plugin does not change the Agent call.
The routing request has a five-second time limit.
The decision log can add up to one second.
After setup, the plugin can start the daemon if it stopped.
The plugin skips routing for the call that starts the daemon.
The daemon stops after 30 minutes without a request.

The plugin also tells the parent to add task metadata to subagent prompts.
The metadata describes the work and the decisions that stay open.
The plugin keeps the initial prompt for the subagent.

The plugin does not route fork subagents.
It cannot find plugin agent definitions from a plugin loaded only with `--plugin-dir`.
It can find definitions from marketplace installations.

## Configuration

Set environment variables before you start Claude Code.

| Variable | Default | Effect |
| --- | --- | --- |
| `S1_MODEL` | `2B` | Selects the local Decider model. The permitted values are `2B` and `4B`. |
| `S1_ROUTER` | Unset | The value `off` stops model and effort selection. It does not stop decision logs. |
| `S1_ROUTER_CEILING` | `parent` | The value `none` removes the parent ceiling. |
| `S1_ROUTER_CONFIG` | Unset | Gives the path to a routing configuration file. |

For example, start a session with the `4B` model:

```sh
S1_MODEL=4B claude
```

Then enter this command at the Claude Code prompt:

```text
/s1-setup --restart
```

All your sessions use one daemon.
The restart changes the model for all sessions that use it.
A change to `S1_MODEL` alone does not replace an active model.

### Routing configuration file

1. If necessary, make a `.claude` directory in your project.
2. Copy [the default configuration](hooks/default-config.yaml) to `.claude/s1-auto-router.yaml`.
3. Change the configuration values as necessary.

The plugin examines these locations in sequence:

1. The path in `S1_ROUTER_CONFIG`
2. Your project's `.claude/s1-auto-router.yaml`, `.yml`, or `.json`
3. Your home directory's `.claude/s1-auto-router.yaml`, `.yml`, or `.json`
4. The default configuration in the plugin.

The first file replaces the complete default configuration.
The plugin uses data from only one configuration file.
At one location, the plugin uses `.yaml` before `.yml`, then `.json`.
An invalid file prevents routing for that call.

| Field | Default | Effect |
| --- | --- | --- |
| `threshold` | `0.6` | Prevents a change to an output if an answer on its decision path has lower confidence. |
| `prompt_max_chars` | `4000` | Limits the assignment text sent to Decider. The value `0` removes the limit. |
| `questions` | Default questions | Gives the questions sent to Decider. |
| `trees` | Default rules | Gives the decision rules for `model` and `effort`. |

The commented default file gives the question and rule formats.
[Solution Space routing](docs/design/solution-space-routing.md) describes a separate experimental configuration.
Installation does not activate that configuration.

## Updates

1. Update the marketplace from your terminal.

   ```sh
   claude plugin marketplace update s1-auto-router
   ```

2. Update the plugin.

   ```sh
   claude plugin update s1-auto-router@s1-auto-router
   ```

3. Start a new Claude Code session.
4. At the Claude Code prompt, enter `/s1-setup --restart`.

Each installed version uses its own Python environment.
The restart also replaces the daemon that used the previous version.

## Troubleshooting

| Problem | Procedure |
| --- | --- |
| The marketplace cannot be added | Make sure that Git is installed. Make sure that you can access the repository URL. |
| `/s1-setup` is missing | Examine the Installed tab in `/plugin`. Make sure that your Claude Code version supports mods. |
| Setup reports that `uv` is missing | Make `uv` available in the terminal that starts Claude Code. |
| Setup cannot download the model | Make sure that you can access Hugging Face. Enter `/s1-setup` again. |
| Setup does not become ready | Examine `~/.cache/s1-auto-router/daemon.log`. |
| The terminal shows a model mismatch message | Enter `/s1-setup --restart` with the correct `S1_MODEL` value. |
| The reason is `explicit` | The Agent call or definition gives the values. |
| The reason is `abstain` | A Decider answer does not have sufficient confidence. The plugin keeps the initial output value. |
| The reason is `S1 cold start` | The daemon starts in the background. Give the subagent one more task after startup. |
| The reason is `S1 not set up` | Enter `/s1-setup` in the session that loads the installed plugin. |
| The terminal shows a routing configuration error | Compare the file with the commented default configuration. |

## Data storage

Decider receives subagent task data through a local Unix socket.
The plugin does not send routing requests to an external Decider service.
Model downloads use Hugging Face.
Claude Code sends subagent assignments to Claude models.

The plugin writes a decision for each Agent call to `~/.cache/s1-auto-router/decisions.jsonl`.
Decisions can contain prompt text, task metadata, questions, probabilities, selected values, and error details.
The default prompt limit is 4,000 characters.
The limit does not include all other fields.
The log file has owner-only read and write permissions.
The plugin does not limit the log size or remove old log data.

The daemon writes process output to `~/.cache/s1-auto-router/daemon.log`.

`S1_ROUTER=off` does not stop decision logs or the task metadata instruction.
Disable the plugin to stop its hooks in new sessions.

## Disable or remove

To stop routing for one new session, start Claude Code with this variable:

```sh
S1_ROUTER=off claude
```

To stop all plugin hooks, disable the plugin from your terminal:

```sh
claude plugin disable s1-auto-router@s1-auto-router --scope user
```

Then close the sessions that loaded the plugin.
To remove the installed plugin, enter this command:

```sh
claude plugin uninstall s1-auto-router@s1-auto-router --scope user
```

Removal does not remove decision logs or model downloads.
The daemon can stay active until its 30-minute idle limit.
After the daemon stops, you can remove `~/.cache/s1-auto-router` to erase its logs and local state.
Decider model files stay in the Hugging Face cache.

## More information

- [Project terms](GLOSSARY.md)
- [Daemon design](docs/adr/0001-shared-s1-daemon.md)
- [Task metadata design](docs/adr/0002-native-agent-routing-metadata.md)
- [Evaluation results](eval/README.md)
- [Contributor instructions](CLAUDE.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md).

This user guide follows the writing rules and vocabulary of [ASD-STE100, Issue 9](https://www.asd-ste100.org/about_STE.html).
