//go:build !localonly

package tui

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"golang.org/x/sync/errgroup"

	tui "github.com/junhoyeo/contrabass/internal/tui"
)

// tuiProgramConfig holds the configuration for the read-only cloud TUI.
type tuiProgramConfig struct {
	TeamID       string
	SessionToken string
	SubscribeURL string
}

// tuiConnState is the WebSocket connection state shown in the header.
type tuiConnState int

const (
	tuiConnConnecting tuiConnState = iota
	tuiConnConnected
	tuiConnReconnecting
)

// BubbleTea message types used to update the model from background goroutines.
type (
	tuiFrameMsg     struct{ frame tuiSubscribeFrame }
	tuiConnStateMsg struct{ state tuiConnState }
)

// tuiModel is the BubbleTea model for the read-only cloud TUI.
type tuiModel struct {
	teamID    string
	connState tuiConnState
	spinner   spinner.Model
	help      help.Model
	keys      tui.CloudKeyMap

	boardEntries map[string]tuiBoardEntry   // keyed by issueRef
	boardKeys    []string                   // sorted issueRef list
	workers      map[string]tuiWorkerStatus // keyed by workerId
	recentEvents []tuiRunEvent
	runEventLogs map[string]*tui.EventLog // per-issueRef event log for detail view
	configHash   string

	boardView  tui.CloudBoardView
	detailView tui.CloudRunDetailView
	viewMode   tui.CloudViewMode

	width  int
	height int
}

func newTUIModel(teamID string) tuiModel {
	bv := tui.NewCloudBoardView().SetFocused(true)
	keys := tui.NewCloudKeyMap()
	return tuiModel{
		teamID:       teamID,
		connState:    tuiConnConnecting,
		spinner:      spinner.New(spinner.WithSpinner(spinner.Dot)),
		help:         help.New(),
		keys:         keys,
		boardEntries: make(map[string]tuiBoardEntry),
		workers:      make(map[string]tuiWorkerStatus),
		recentEvents: make([]tuiRunEvent, 0),
		runEventLogs: make(map[string]*tui.EventLog),
		boardView:    bv,
		detailView:   tui.NewCloudRunDetailView(),
		viewMode:     tui.CloudViewOverview,
	}
}

func (m tuiModel) Init() tea.Cmd {
	return m.spinner.Tick
}

func (m tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		switch {
		case key.Matches(msg, m.keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, m.keys.Up):
			if m.viewMode == tui.CloudViewOverview {
				m = m.moveCursor(-1)
			}
		case key.Matches(msg, m.keys.Down):
			if m.viewMode == tui.CloudViewOverview {
				m = m.moveCursor(1)
			}
		case key.Matches(msg, m.keys.Enter):
			if m.viewMode == tui.CloudViewOverview && m.boardView.RowCount() > 0 {
				m.viewMode = tui.CloudViewDetail
				m.keys = m.keys.SetViewMode(tui.CloudViewDetail)
			}
		case key.Matches(msg, m.keys.Back):
			if m.viewMode == tui.CloudViewDetail {
				m.viewMode = tui.CloudViewOverview
				m.keys = m.keys.SetViewMode(tui.CloudViewOverview)
			}
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.help.SetWidth(msg.Width)
		m.boardView = m.boardView.SetWidth(msg.Width)
		m.detailView = m.detailView.SetWidth(msg.Width)
	case spinner.TickMsg:
		m.spinner, cmd = m.spinner.Update(msg)
	case tuiConnStateMsg:
		m.connState = msg.state
	case tuiFrameMsg:
		m = m.applyFrame(msg.frame)
	}
	return m, cmd
}

func (m tuiModel) moveCursor(delta int) tuiModel {
	count := m.boardView.RowCount()
	if count == 0 {
		return m
	}
	sel := m.boardView.Selected() + delta
	if sel < 0 {
		sel = 0
	}
	if sel >= count {
		sel = count - 1
	}
	m.boardView = m.boardView.SetSelected(sel)
	return m
}

// syncBoardView rebuilds the CloudBoardView rows from boardEntries/boardKeys.
// Call this after any mutation to boardEntries or boardKeys.
func (m tuiModel) syncBoardView() tuiModel {
	entries := make([]tui.CloudBoardEntry, 0, len(m.boardKeys))
	for _, ref := range m.boardKeys {
		e := m.boardEntries[ref]
		entries = append(entries, tui.CloudBoardEntry{
			IssueRef:         e.IssueRef,
			Phase:            e.Phase,
			AssignedWorkerID: e.AssignedWorkerID,
			RunID:            e.RunID,
			LastUpdated:      e.LastUpdated,
		})
	}
	// Clamp selected index after board snapshot replacement.
	sel := m.boardView.Selected()
	if n := len(entries); n == 0 {
		sel = 0
	} else if sel >= n {
		sel = n - 1
	}
	m.boardView = m.boardView.SetRows(entries).SetSelected(sel)
	return m
}

const tuiMaxRecentEvents = 20

func (m tuiModel) applyFrame(frame tuiSubscribeFrame) tuiModel {
	switch frame.Type {
	case tuiFrameTypeBoardUpdate:
		if frame.BoardUpdate == nil {
			return m
		}
		m.boardEntries = make(map[string]tuiBoardEntry, len(frame.BoardUpdate.Entries))
		for _, e := range frame.BoardUpdate.Entries {
			m.boardEntries[e.IssueRef] = e
		}
		m.boardKeys = make([]string, 0, len(m.boardEntries))
		for k := range m.boardEntries {
			m.boardKeys = append(m.boardKeys, k)
		}
		sort.Strings(m.boardKeys)
		m = m.syncBoardView()

	case tuiFrameTypeRunEvent:
		if frame.RunEvent == nil {
			return m
		}
		m.recentEvents = append(m.recentEvents, *frame.RunEvent)
		if len(m.recentEvents) > tuiMaxRecentEvents {
			m.recentEvents = m.recentEvents[len(m.recentEvents)-tuiMaxRecentEvents:]
		}
		// Accumulate per-issue event log for the run-detail view.
		if ref := frame.RunEvent.IssueRef; ref != "" {
			evLog := m.runEventLogs[ref]
			if evLog == nil {
				evLog = tui.NewEventLog(tui.DefaultEventLogSize)
				m.runEventLogs[ref] = evLog
			}
			ts := time.Now()
			if frame.RunEvent.Timestamp != "" {
				if parsed, parseErr := time.Parse(time.RFC3339, frame.RunEvent.Timestamp); parseErr == nil {
					ts = parsed
				}
			}
			evLog.Push(tui.EventLogEntry{
				Timestamp: ts,
				Type:      frame.RunEvent.EventType,
				Detail:    frame.RunEvent.RunID,
			})
		}

	case tuiFrameTypeWorkerStatus:
		if frame.WorkerStatus == nil {
			return m
		}
		m.workers[frame.WorkerStatus.WorkerID] = *frame.WorkerStatus

	case tuiFrameTypeConfigChanged:
		if frame.ConfigChanged == nil {
			return m
		}
		m.configHash = frame.ConfigChanged.Hash
	}
	return m
}

var (
	tuiStyleTitle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("205"))
	tuiStyleHeader = lipgloss.NewStyle().Bold(true).Underline(true)
	tuiStyleFaint  = lipgloss.NewStyle().Faint(true)
)

func (m tuiModel) View() tea.View {
	var b strings.Builder

	// Header: team name + connection state + config hash.
	connLabel := ""
	switch m.connState {
	case tuiConnConnecting:
		connLabel = m.spinner.View() + " connecting…"
	case tuiConnReconnecting:
		connLabel = m.spinner.View() + " reconnecting…"
	case tuiConnConnected:
		connLabel = "● connected"
	}
	b.WriteString(tuiStyleTitle.Render(fmt.Sprintf("contrabass tui — %s", m.teamID)))
	b.WriteString("  ")
	b.WriteString(tuiStyleFaint.Render(connLabel))
	if m.configHash != "" {
		short := m.configHash
		if len(short) > 8 {
			short = short[:8]
		}
		b.WriteString(tuiStyleFaint.Render("  config:" + short))
	}
	b.WriteString("\n\n")

	if m.viewMode == tui.CloudViewDetail {
		if entry, ok := m.boardView.SelectedEntry(); ok {
			var events []tui.EventLogEntry
			if evLog := m.runEventLogs[entry.IssueRef]; evLog != nil {
				events = evLog.Entries()
			}
			b.WriteString(m.detailView.Render(entry, events))
		} else {
			b.WriteString(tuiStyleFaint.Render("  (no selection)\n"))
		}
	} else {
		b.WriteString(m.boardView.View())
		b.WriteString("\n\n")

		// Workers summary.
		b.WriteString(tuiStyleHeader.Render("Workers"))
		b.WriteString("\n")
		if len(m.workers) == 0 {
			b.WriteString(tuiStyleFaint.Render("  (none registered)\n"))
		} else {
			workerIDs := make([]string, 0, len(m.workers))
			for id := range m.workers {
				workerIDs = append(workerIDs, id)
			}
			sort.Strings(workerIDs)
			for _, id := range workerIDs {
				w := m.workers[id]
				b.WriteString(fmt.Sprintf("  %-24s  %-12s  %s\n", id, w.Status, tuiStyleFaint.Render(w.Kind)))
			}
		}
	}
	b.WriteString("\n")
	b.WriteString(m.help.View(m.keys))

	v := tea.NewView(b.String())
	v.AltScreen = true
	return v
}

// runTUIProgram starts the BubbleTea program and the background WebSocket
// subscriber, wiring them together through a buffered channel. It blocks until
// the user quits or ctx is cancelled.
func runTUIProgram(ctx context.Context, cfg tuiProgramConfig) error {
	frames := make(chan tuiSubscribeFrame, 32)

	prog := tea.NewProgram(newTUIModel(cfg.TeamID))

	sub := &tuiSubscriber{
		subscribeURL: cfg.SubscribeURL,
		sessionToken: cfg.SessionToken,
		onConnected: func() {
			prog.Send(tuiConnStateMsg{state: tuiConnConnected})
		},
		onReconnecting: func() {
			prog.Send(tuiConnStateMsg{state: tuiConnReconnecting})
		},
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var g errgroup.Group

	// Subscriber goroutine: reconnects automatically until ctx is cancelled.
	g.Go(func() error {
		err := sub.Run(ctx, frames)
		// Propagate non-context errors by quitting the program so the user
		// sees the process exit rather than a frozen TUI.
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			prog.Quit()
		}
		return err
	})

	// Frame forwarder goroutine: relays decoded frames to the BubbleTea program.
	g.Go(func() error {
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case frame, ok := <-frames:
				if !ok {
					return nil
				}
				prog.Send(tuiFrameMsg{frame: frame})
			}
		}
	})

	// Run the BubbleTea program in this goroutine; it blocks until quit.
	_, runErr := prog.Run()
	cancel() // signal subscriber and forwarder to stop

	_ = g.Wait() // drain goroutines; context-cancelled errors are expected

	if runErr != nil {
		return fmt.Errorf("tui program: %w", runErr)
	}
	return nil
}
