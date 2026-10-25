package ru.smartcatfeeder;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.Instant;

/** Проверенный результат именно той ручной команды, которую ожидает клиент. */
public final class FeedingResult {
    public final String feedingId;
    public final String status;
    public final BigDecimal actualGrams;
    public final String errorCode;

    private FeedingResult(String feedingId, String status, BigDecimal actualGrams, String errorCode) {
        this.feedingId = feedingId;
        this.status = status;
        this.actualGrams = actualGrams;
        this.errorCode = errorCode;
    }

    public static FeedingResult parse(String feedingId, String commandId, JSONObject body) throws JSONException {
        if (!feedingId.equals(body.getString("feeding_id"))
                || !commandId.equals(body.getString("command_id"))
                || !"manual".equals(body.getString("source"))) {
            throw new JSONException("Result belongs to another command");
        }
        String status = body.getString("status");
        if (!status.equals("pending") && !status.equals("running") && !ManualCommand.terminal(status))
            throw new JSONException("Unknown feeding status");
        BigDecimal actual = null;
        if (!body.isNull("actual_grams")) {
            Object number = body.get("actual_grams");
            if (!(number instanceof Number)) throw new JSONException("Expected numeric actual_grams");
            try {
                actual = new BigDecimal(number.toString());
                if (actual.signum() < 0) throw new NumberFormatException();
            } catch (NumberFormatException error) { throw new JSONException("Invalid actual_grams"); }
        }
        if ("completed".equals(status) && actual == null) throw new JSONException("Missing actual_grams");
        if ("completed".equals(status) || "failed".equals(status)) {
            try { Instant.parse(body.getString("finished_at")); }
            catch (Exception error) { throw new JSONException("Invalid finished_at"); }
        }
        return new FeedingResult(feedingId, status, actual,
                body.isNull("error_code") ? null : body.getString("error_code"));
    }

    public boolean terminal() { return ManualCommand.terminal(status); }
}
