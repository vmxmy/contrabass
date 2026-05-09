package tui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/key"
	"charm.land/lipgloss/v2"
	ltable "charm.land/lipgloss/v2/table"
)

// CloudViewMode tracks whether the cloud TUI shows the board list or a run detail.
type CloudViewMode int

const (
	CloudViewOverview CloudViewMode = iota
	CloudViewDetail
)

// CloudBoardEntry is one row in the cloud team board view.
type CloudBoardEntry struct {
	IssueRef         string
	Phase            string
	AssignedWorkerID string
	RunID            string
	LastUpdated      string
}

// CloudWorkerEntry is one worker row in the cloud workers view.
type CloudWorkerEntry struct {
	WorkerID string
	Status   string
	Kind     string
}

// cloudPhaseColor returns an ANSI 256-color index for the given cloud board phase.
func cloudPhaseColor(phase string) string {
	switch phase {
	case "running":
		return "82"
	case "claimed", "dispatched":
		return "214"
	case "succeeded":
		return "10"
	case "failed":
		return "9"
	case "cancelled":
		return "240"
	default:
		return "33"
	}
}

var (
	cloudHeaderStyle = lipgloss.NewStyle().Bold(true).Faint(true).Padding(0, 1)
	cloudFaintStyle  = lipgloss.NewStyle().Faint(true)
)

// CloudBoardView renders a lipgloss table of cloud board entries with cursor support.
type CloudBoardView struct {
	width    int
	rows     []CloudBoardEntry
	selected int
	focused  bool
}

func NewCloudBoardView() CloudBoardView {
	return CloudBoardView{}
}

func (v CloudBoardView) SetWidth(w int) CloudBoardView           { v.width = w; return v }
func (v CloudBoardView) SetRows(r []CloudBoardEntry) CloudBoardView { v.rows = r; return v }
func (v CloudBoardView) SetSelected(i int) CloudBoardView        { v.selected = i; return v }
func (v CloudBoardView) SetFocused(f bool) CloudBoardView        { v.focused = f; return v }
func (v CloudBoardView) RowCount() int                           { return len(v.rows) }
func (v CloudBoardView) Selected() int                           { return v.selected }

// SelectedEntry returns the currently selected row.
func (v CloudBoardView) SelectedEntry() (CloudBoardEntry, bool) {
	if v.selected < 0 || v.selected >= len(v.rows) {
		return CloudBoardEntry{}, false
	}
	return v.rows[v.selected], true
}

func (v CloudBoardView) View() string {
	if len(v.rows) == 0 {
		return cloudFaintStyle.Render("  No issues on the board")
	}

	tableRows := make([][]string, 0, len(v.rows))
	for i, r := range v.rows {
		glyph := "●"
		if v.focused && i == v.selected {
			glyph = "▶"
		}
		worker := r.AssignedWorkerID
		if worker == "" {
			worker = "-"
		}
		tableRows = append(tableRows, []string{glyph, r.IssueRef, r.Phase, worker})
	}

	tbl := ltable.New().
		Headers("", "ISSUE", "PHASE", "WORKER").
		Rows(tableRows...).
		Wrap(false).
		Border(lipgloss.NormalBorder()).
		BorderTop(false).
		BorderBottom(false).
		BorderLeft(false).
		BorderRight(false).
		BorderColumn(false).
		BorderRow(false).
		BorderHeader(true).
		BorderStyle(lipgloss.NewStyle().Faint(true).Foreground(lipgloss.Color("240"))).
		StyleFunc(func(row, col int) lipgloss.Style {
			if row == ltable.HeaderRow {
				return cloudHeaderStyle
			}
			isSelected := v.focused && row == v.selected
			phase := v.rows[row].Phase

			bg := "234"
			if row%2 == 1 {
				bg = "235"
			}
			if isSelected {
				bg = "238"
			}
			base := lipgloss.NewStyle().Padding(0, 1).Background(lipgloss.Color(bg))
			if isSelected {
				base = base.Bold(true).Foreground(lipgloss.Color("255"))
			}
			switch col {
			case 0:
				if isSelected {
					return base.Foreground(lipgloss.Color("42"))
				}
				return base.Foreground(lipgloss.Color(cloudPhaseColor(phase)))
			case 2:
				if !isSelected {
					return base.Foreground(lipgloss.Color(cloudPhaseColor(phase)))
				}
				return base
			default:
				return base
			}
		})

	if v.width > 2 {
		tbl.Width(v.width - 2)
	}

	title := "  BOARD"
	if v.focused {
		title = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("42")).Render(title)
	} else {
		title = cloudFaintStyle.Foreground(lipgloss.Color("240")).Render(title)
	}
	return title + "\n" + lipgloss.NewStyle().PaddingLeft(2).Render(tbl.String())
}

// CloudRunDetailView renders detail for a selected board entry plus its EventLog.
type CloudRunDetailView struct {
	width int
}

func NewCloudRunDetailView() CloudRunDetailView {
	return CloudRunDetailView{}
}

func (d CloudRunDetailView) SetWidth(w int) CloudRunDetailView {
	d.width = w
	return d
}

// Render returns the detail view string for the given board entry and its events.
func (d CloudRunDetailView) Render(entry CloudBoardEntry, events []EventLogEntry) string {
	w := d.width
	if w <= 0 {
		w = 80
	}

	labelStyle := lipgloss.NewStyle().Faint(true).Foreground(lipgloss.Color("244"))
	valueStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("45"))
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("42"))
	dimStyle := lipgloss.NewStyle().Faint(true)
	timeStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("240"))

	worker := entry.AssignedWorkerID
	if worker == "" {
		worker = "-"
	}

	var b strings.Builder
	b.WriteString(titleStyle.Render(fmt.Sprintf("  ISSUE  %s", entry.IssueRef)))
	b.WriteByte('\n')
	b.WriteString(fmt.Sprintf("  %s %s    %s %s",
		labelStyle.Render("Phase:"), valueStyle.Render(entry.Phase),
		labelStyle.Render("Worker:"), valueStyle.Render(worker),
	))
	b.WriteByte('\n')
	if entry.RunID != "" {
		b.WriteString(fmt.Sprintf("  %s %s",
			labelStyle.Render("Run:"), valueStyle.Render(entry.RunID),
		))
		b.WriteByte('\n')
	}

	sep := w - 4
	if sep < 0 {
		sep = 0
	}
	b.WriteString("  " + dimStyle.Render(strings.Repeat("─", sep)) + "\n")
	b.WriteString(titleStyle.Render("  EVENT LOG") + "\n")

	if len(events) == 0 {
		b.WriteString(dimStyle.Render("  No events recorded"))
	} else {
		for _, e := range events {
			ts := e.Timestamp.Format("15:04:05")
			line := fmt.Sprintf("  %s  %s", timeStyle.Render(ts), valueStyle.Render(e.Type))
			if e.Detail != "" {
				line += "  " + dimStyle.Render(e.Detail)
			}
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}

	return b.String()
}

// CloudKeyMap holds key bindings for the cloud TUI.
// It implements help.KeyMap and adapts ShortHelp based on the current view mode.
type CloudKeyMap struct {
	Quit     key.Binding
	Up       key.Binding
	Down     key.Binding
	Enter    key.Binding
	Back     key.Binding
	viewMode CloudViewMode
}

func NewCloudKeyMap() CloudKeyMap {
	return CloudKeyMap{
		Quit: key.NewBinding(
			key.WithKeys("q", "ctrl+c"),
			key.WithHelp("q", "quit"),
		),
		Up: key.NewBinding(
			key.WithKeys("up", "k"),
			key.WithHelp("↑/k", "up"),
		),
		Down: key.NewBinding(
			key.WithKeys("down", "j"),
			key.WithHelp("↓/j", "down"),
		),
		Enter: key.NewBinding(
			key.WithKeys("enter"),
			key.WithHelp("⏎", "view detail"),
		),
		Back: key.NewBinding(
			key.WithKeys("esc"),
			key.WithHelp("esc", "back"),
		),
	}
}

func (k CloudKeyMap) SetViewMode(vm CloudViewMode) CloudKeyMap {
	k.viewMode = vm
	return k
}

func (k CloudKeyMap) ShortHelp() []key.Binding {
	if k.viewMode == CloudViewDetail {
		return []key.Binding{k.Back, k.Quit}
	}
	return []key.Binding{k.Up, k.Down, k.Enter, k.Quit}
}

func (k CloudKeyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Up, k.Down},
		{k.Enter, k.Back},
		{k.Quit},
	}
}
