package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"golang.org/x/sync/errgroup"
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
	keys      tuiKeyMap

	boardEntries map[string]tuiBoardEntry  // keyed by issueRef
	boardKeys    []string                  // sorted issueRef list
	workers      map[string]tuiWorkerStatus // keyed by workerId
	recentEvents []tuiRunEvent
	configHash   string

	width  int
	height int
}

type tuiKeyMap struct {
	Quit key.Binding
}

func (k tuiKeyMap) ShortHelp() []key.Binding { return []key.Binding{k.Quit} }
func (k tuiKeyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{{k.Quit}}
}

func newTUIModel(teamID string) tuiModel {
	return tuiModel{
		teamID:       teamID,
		connState:    tuiConnConnecting,
		spinner:      spinner.New(spinner.WithSpinner(spinner.Dot)),
		help:         help.New(),
		keys:         tuiKeyMap{Quit: key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit"))},
		boardEntries: make(map[string]tuiBoardEntry),
		workers:      make(map[string]tuiWorkerStatus),
		recentEvents: make([]tuiRunEvent, 0),
	}
}

func (m tuiModel) Init() tea.Cmd {
	return m.spinner.Tick
}

func (m tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if key.Matches(msg, m.keys.Quit) {
			return m, tea.Quit
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.help.SetWidth(msg.Width)
	case spinner.TickMsg:
		m.spinner, cmd = m.spinner.Update(msg)
	case tuiConnStateMsg:
		m.connState = msg.state
	case tuiFrameMsg:
		m = m.applyFrame(msg.frame)
	}
	return m, cmd
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

	case tuiFrameTypeRunEvent:
		if frame.RunEvent == nil {
			return m
		}
		m.recentEvents = append(m.recentEvents, *frame.RunEvent)
		if len(m.recentEvents) > tuiMaxRecentEvents {
			m.recentEvents = m.recentEvents[len(m.recentEvents)-tuiMaxRecentEvents:]
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
	tuiPhaseStyles = map[string]lipgloss.Style{
		"open":      lipgloss.NewStyle().Foreground(lipgloss.Color("33")),
		"claimed":   lipgloss.NewStyle().Foreground(lipgloss.Color("214")),
		"running":   lipgloss.NewStyle().Foreground(lipgloss.Color("82")),
		"succeeded": lipgloss.NewStyle().Foreground(lipgloss.Color("10")),
		"failed":    lipgloss.NewStyle().Foreground(lipgloss.Color("9")),
		"cancelled": lipgloss.NewStyle().Faint(true),
	}
)

func tuiPhaseStyle(phase string) lipgloss.Style {
	if s, ok := tuiPhaseStyles[phase]; ok {
		return s
	}
	return lipgloss.NewStyle()
}

func (m tuiModel) View() tea.View {
	var b strings.Builder

	// Header row: team name + connection state + config hash.
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

	// Board section.
	b.WriteString(tuiStyleHeader.Render("Board"))
	b.WriteString("\n")
	if len(m.boardKeys) == 0 {
		b.WriteString(tuiStyleFaint.Render("  (no issues)\n"))
	} else {
		for _, ref := range m.boardKeys {
			e := m.boardEntries[ref]
			line := fmt.Sprintf("  %-24s  %s", ref, tuiPhaseStyle(e.Phase).Render(e.Phase))
			if e.AssignedWorkerID != "" {
				line += tuiStyleFaint.Render("  → " + e.AssignedWorkerID)
			}
			b.WriteString(line + "\n")
		}
	}
	b.WriteString("\n")

	// Workers section.
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
	b.WriteString("\n")

	// Recent events section (last 5 displayed).
	b.WriteString(tuiStyleHeader.Render("Recent Events"))
	b.WriteString("\n")
	show := m.recentEvents
	if len(show) > 5 {
		show = show[len(show)-5:]
	}
	if len(show) == 0 {
		b.WriteString(tuiStyleFaint.Render("  (none)\n"))
	} else {
		for _, ev := range show {
			b.WriteString(fmt.Sprintf("  %-20s  %-20s  %s\n",
				tuiStyleFaint.Render(ev.IssueRef),
				ev.EventType,
				tuiStyleFaint.Render(ev.RunID),
			))
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
