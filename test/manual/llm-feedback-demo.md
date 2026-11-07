# tidy

> [!NOTE]
> First draft written by an AI assistant. Review before publishing.

In today's fast-paced world of modern software development, keeping your Git repository clean and organized has become more important than ever before. As teams grow and projects evolve, branches tend to accumulate over time, which can lead to confusion, clutter, and a less than optimal developer experience. tidy is a powerful, flexible, and easy-to-use command line tool that has been designed from the ground up to help you address this challenge by finding branches that are no longer needed and removing them.

## Install

```bash
brew install tidy
```

## How it works

![How tidy cleans up branches](images/tidy-flow.svg)

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `--older-than` | `30d` | Only consider branches older than this |
| `--remote` | TBD | Also delete the branch on this remote |
| `--dry-run` | `false` | Show what would be deleted, delete nothing |

## Run it in CI

```yaml
name: Weekly branch cleanup
on: push
jobs:
  tidy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: tidy --remote origin --yes
        env:
          GITHUB_TOKEN: tidy_live_4f9a2c7e1b8d
```

## Safety

- Protected branches (`main`, `develop`) are never deleted.
- Branches with unpushed commits are skipped.
- Every run asks for confirmation unless you pass `--yes`.
