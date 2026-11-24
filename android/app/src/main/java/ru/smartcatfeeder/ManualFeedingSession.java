package ru.smartcatfeeder;

import java.time.Instant;
import java.util.Objects;

/** Хранит в памяти состояние ручной команды и обеспечивает безопасный повтор. */
public final class ManualFeedingSession {
    private State state = State.IDLE;
    private ManualCommand command;
    private ManualCommandResponse acceptedResponse;
    private Feeding currentFeeding;

    public State state() {
        return state;
    }

    public void begin(ManualCommand command) {
        this.command = Objects.requireNonNull(command, "command");
        acceptedResponse = null;
        currentFeeding = null;
        state = State.SENDING;
    }

    public void markUncertain(ManualCommand command) {
        requireCurrent(command);
        state = State.RETRY_AVAILABLE;
    }

    public void markRejected(ManualCommand command) {
        requireCurrent(command);
        clear();
    }

    public void markAccepted(ManualCommand command, ManualCommandResponse response) {
        requireCurrent(command);
        ManualCommandResponse accepted = Objects.requireNonNull(response, "response");
        if (!command.commandId.equals(accepted.feeding.commandId)) {
            throw new IllegalArgumentException("Ответ относится к другой команде");
        }
        acceptedResponse = accepted;
        currentFeeding = accepted.feeding;
        state = currentFeeding.terminal() ? State.FINISHED : State.ACCEPTED;
    }

    public ManualCommand retryCommand(Instant now) {
        Objects.requireNonNull(now, "now");
        if (state != State.RETRY_AVAILABLE) {
            return null;
        }
        if (!now.isBefore(command.expiresAt)) {
            clear();
            return null;
        }
        return command;
    }

    public ManualCommandResponse acceptedResponse() {
        return acceptedResponse;
    }

    public Feeding currentFeeding() {
        return currentFeeding;
    }

    public void updateFeeding(Feeding feeding) {
        Feeding updated = Objects.requireNonNull(feeding, "feeding");
        if (acceptedResponse == null
                || !acceptedResponse.feeding.feedingId.equals(updated.feedingId)
                || !acceptedResponse.feeding.deviceId.equals(updated.deviceId)
                || !command.commandId.equals(updated.commandId)
                || updated.source != Feeding.Source.MANUAL) {
            throw new IllegalArgumentException("Получено состояние другого кормления");
        }
        currentFeeding = updated;
        state = updated.terminal() ? State.FINISHED : State.ACCEPTED;
    }

    public void clear() {
        state = State.IDLE;
        command = null;
        acceptedResponse = null;
        currentFeeding = null;
    }

    private void requireCurrent(ManualCommand value) {
        Objects.requireNonNull(value, "command");
        if (command == null || !command.commandId.equals(value.commandId)) {
            throw new IllegalStateException("Команда больше не является текущей");
        }
    }

    public enum State {
        IDLE,
        SENDING,
        RETRY_AVAILABLE,
        ACCEPTED,
        FINISHED
    }
}
