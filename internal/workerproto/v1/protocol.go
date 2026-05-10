package v1

const ProtocolVersionCurrent ProtocolVersion = "1.0.0"

type WorkerAckRequest interface {
	isWorkerAckRequest()
}

func (Accept) isWorkerAckRequest() {}
func (Reject) isWorkerAckRequest() {}

type WorkerCompleteRequest interface {
	isWorkerCompleteRequest()
}

func (SucceededCompletion) isWorkerCompleteRequest() {}
func (FailedCompletion) isWorkerCompleteRequest()    {}
func (CancelledCompletion) isWorkerCompleteRequest() {}
