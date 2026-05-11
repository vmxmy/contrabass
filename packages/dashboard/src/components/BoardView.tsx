import { useEffect, useMemo, useState } from 'react'
import { Badge, Banner, Button, Empty, Input, InputArea, LayerCard, Table } from '@cloudflare/kumo'
import type { BoardIssue } from '../types'
import { formatDateTime, formatIssueState } from '../i18n/format'
import { zhCN } from '../i18n/messages'
import { apiFetch } from '../lib/api'

interface BoardViewProps {
  issues: BoardIssue[]
}

type IssueState = 'open' | 'in_progress' | 'done'

interface EditableDraft {
  title: string
  description: string
}

function sortByUpdatedAtDesc(entries: BoardIssue[]): BoardIssue[] {
  return [...entries].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  )
}

function getStateLabel(state: string): string {
  return formatIssueState(state)
}

function stateVariant(state: string): 'secondary' | 'warning' | 'success' {
  if (state === 'in_progress') {
    return 'warning'
  }

  if (state === 'done') {
    return 'success'
  }

  return 'secondary'
}

async function readIssueFromResponse(response: Response): Promise<BoardIssue | null> {
  const bodyText = await response.text()
  if (!bodyText) {
    return null
  }

  try {
    return JSON.parse(bodyText) as BoardIssue
  } catch {
    return null
  }
}

function toIssueState(value: string): IssueState {
  if (value === 'in_progress' || value === 'done') {
    return value
  }

  return 'open'
}

function updateIssueList(
  entries: BoardIssue[],
  identifier: string,
  patch: Partial<Pick<BoardIssue, 'title' | 'description' | 'state'>>,
): BoardIssue[] {
  return entries.map((entry) => {
    if (entry.identifier !== identifier) {
      return entry
    }

    return {
      ...entry,
      ...patch,
      updated_at: new Date().toISOString(),
    }
  })
}

export function BoardView({ issues }: BoardViewProps) {
  const [localIssues, setLocalIssues] = useState(() => sortByUpdatedAtDesc(issues))
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [editingIdentifier, setEditingIdentifier] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<EditableDraft>({ title: '', description: '' })
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    setLocalIssues(sortByUpdatedAtDesc(issues))
  }, [issues])

  const sortedIssues = useMemo(() => sortByUpdatedAtDesc(localIssues), [localIssues])

  async function handleCreateIssue(event: { preventDefault: () => void }) {
    event.preventDefault()

    const nextTitle = title.trim()
    const nextDescription = description.trim()
    if (!nextTitle) {
      return
    }

    setErrorMessage('')
    setSubmitting(true)

    try {
      const response = await apiFetch('/api/v1/board/issues', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: nextTitle, description: nextDescription }),
      })

      if (!response.ok) {
        throw new Error(`Failed to create issue (${response.status})`)
      }

      const createdIssue = await readIssueFromResponse(response)
      if (createdIssue) {
        setLocalIssues((prev) => [createdIssue, ...prev])
      }

      setTitle('')
      setDescription('')
    } catch {
      setErrorMessage(zhCN.board.createError)
    } finally {
      setSubmitting(false)
    }
  }

  async function patchIssue(
    identifier: string,
    patch: Partial<Pick<BoardIssue, 'title' | 'description' | 'state'>>,
  ) {
    setErrorMessage('')

    try {
      const response = await apiFetch(`/api/v1/board/issues/${encodeURIComponent(identifier)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
      })

      if (!response.ok) {
        throw new Error(`Failed to update issue (${response.status})`)
      }

      const updatedIssue = await readIssueFromResponse(response)
      if (updatedIssue) {
        setLocalIssues((prev) => prev.map((entry) => (entry.identifier === identifier ? updatedIssue : entry)))
        return
      }

      setLocalIssues((prev) => updateIssueList(prev, identifier, patch))
    } catch {
      setErrorMessage(zhCN.board.updateError(identifier))
    }
  }

  function handleStartEditing(issue: BoardIssue) {
    setEditingIdentifier(issue.identifier)
    setEditDraft({ title: issue.title, description: issue.description })
  }

  function handleCancelEditing() {
    setEditingIdentifier(null)
    setEditDraft({ title: '', description: '' })
  }

  async function handleSaveEdit(identifier: string) {
    const nextTitle = editDraft.title.trim()
    const nextDescription = editDraft.description.trim()

    if (!nextTitle) {
      return
    }

    await patchIssue(identifier, {
      title: nextTitle,
      description: nextDescription,
    })

    setEditingIdentifier(null)
  }

  return (
    <section aria-label={zhCN.board.ariaLabel}>
      <LayerCard className="p-4">
        <form className="grid gap-3 md:grid-cols-3" onSubmit={handleCreateIssue}>
          <Input
            type="text"
            placeholder={zhCN.board.titlePlaceholder}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label={zhCN.board.titlePlaceholder}
            disabled={submitting}
          />
          <Input
            type="text"
            placeholder={zhCN.board.descriptionPlaceholder}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-label={zhCN.board.descriptionPlaceholder}
            disabled={submitting}
          />
          <Button type="submit" variant="primary" disabled={submitting || !title.trim()} loading={submitting}>
            {submitting ? zhCN.board.creating : zhCN.board.create}
          </Button>
        </form>
      </LayerCard>

      {errorMessage ? (
        <div className="mt-3">
          <Banner variant="error" title={errorMessage} />
        </div>
      ) : null}

      {sortedIssues.length === 0 ? (
        <Empty size="sm" title={zhCN.board.empty} />
      ) : (
        <LayerCard className="mt-3 overflow-x-auto p-0">
          <Table aria-label={zhCN.board.tableAriaLabel}>
            <Table.Header>
              <Table.Row>
                <Table.Head>{zhCN.board.headers.identifier}</Table.Head>
                <Table.Head>{zhCN.board.headers.title}</Table.Head>
                <Table.Head>{zhCN.board.headers.state}</Table.Head>
                <Table.Head>{zhCN.board.headers.assignee}</Table.Head>
                <Table.Head>{zhCN.board.headers.updated}</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {sortedIssues.map((issue) => {
                const isEditing = editingIdentifier === issue.identifier

                return (
                  <Table.Row key={issue.id}>
                    <Table.Cell>{issue.identifier}</Table.Cell>
                    <Table.Cell>
                      {isEditing ? (
                        <div className="grid gap-2">
                          <Input
                            type="text"
                            value={editDraft.title}
                            onChange={(event) =>
                              setEditDraft((prev) => ({ ...prev, title: event.target.value }))
                            }
                            aria-label={zhCN.board.editTitleAria(issue.identifier)}
                          />
                          <InputArea
                            value={editDraft.description}
                            onChange={(event) =>
                              setEditDraft((prev) => ({ ...prev, description: event.target.value }))
                            }
                            aria-label={zhCN.board.editDescriptionAria(issue.identifier)}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="primary"
                              onClick={() => {
                                void handleSaveEdit(issue.identifier)
                              }}
                            >
                              {zhCN.board.save}
                            </Button>
                            <Button type="button" size="sm" variant="secondary" onClick={handleCancelEditing}>
                              {zhCN.board.cancel}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button type="button" variant="ghost" onClick={() => handleStartEditing(issue)}>
                          {issue.title}
                        </Button>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="grid gap-2">
                        <Badge variant={stateVariant(issue.state)}>{getStateLabel(issue.state)}</Badge>
                        <div className="flex flex-wrap gap-2">
                          {(['open', 'in_progress', 'done'] as IssueState[]).map((nextState) => {
                            const active = toIssueState(issue.state) === nextState

                            return (
                              <Button
                                key={nextState}
                                size="xs"
                                variant={active ? 'primary' : 'secondary'}
                                type="button"
                                disabled={active}
                                onClick={() => {
                                  void patchIssue(issue.identifier, { state: nextState })
                                }}
                              >
                                {zhCN.board.stateAction(formatIssueState(nextState))}
                              </Button>
                            )
                          })}
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>{issue.assignee || '-'}</Table.Cell>
                    <Table.Cell>{formatDateTime(issue.updated_at)}</Table.Cell>
                  </Table.Row>
                )
              })}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </section>
  )
}

export default BoardView
