package ru.smartcatfeeder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

final class ApiJson {
    private static final BigDecimal MAX_GRAMS = new BigDecimal("999999.99");
    private static final Set<String> DAYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "mon", "tue", "wed", "thu", "fri", "sat", "sun"
    )));

    private ApiJson() {
    }

    static String requiredString(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof String) || ((String) value).isEmpty()) {
            throw invalid(key, "expected non-empty string");
        }
        return (String) value;
    }

    static String nullableString(JSONObject object, String key) throws JSONException {
        if (!object.has(key) || object.isNull(key)) {
            return null;
        }
        return requiredString(object, key);
    }

    static String requiredUuid(JSONObject object, String key) throws JSONException {
        return uuid(requiredString(object, key), key);
    }

    static String nullableUuid(JSONObject object, String key) throws JSONException {
        String value = nullableString(object, key);
        return value == null ? null : uuid(value, key);
    }

    static Instant requiredInstant(JSONObject object, String key) throws JSONException {
        return instant(requiredString(object, key), key);
    }

    static Instant nullableInstant(JSONObject object, String key) throws JSONException {
        String value = nullableString(object, key);
        return value == null ? null : instant(value, key);
    }

    static void requireExpectedId(String actual, String expected, String key) throws JSONException {
        if (!actual.equals(expected)) {
            throw invalid(key, "unexpected identifier");
        }
    }

    static BigDecimal requiredPositiveGrams(JSONObject object, String key) throws JSONException {
        BigDecimal value = decimal(object, key, false);
        if (value.signum() <= 0) {
            throw invalid(key, "must be positive");
        }
        return value;
    }

    static BigDecimal nullableNonNegativeGrams(JSONObject object, String key) throws JSONException {
        if (!object.has(key) || object.isNull(key)) {
            return null;
        }
        BigDecimal value = decimal(object, key, true);
        if (value.signum() < 0) {
            throw invalid(key, "must be non-negative");
        }
        return value;
    }

    static long requiredNonNegativeLong(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof Number)) {
            throw invalid(key, "expected integer");
        }
        long parsed;
        try {
            parsed = new BigDecimal(value.toString()).longValueExact();
        } catch (ArithmeticException | NumberFormatException error) {
            throw invalid(key, "expected integer");
        }
        if (parsed < 0) {
            throw invalid(key, "must be non-negative");
        }
        return parsed;
    }

    static boolean requiredBoolean(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof Boolean)) {
            throw invalid(key, "expected boolean");
        }
        return (Boolean) value;
    }

    static LocalTime requiredLocalTime(JSONObject object, String key) throws JSONException {
        String value = requiredString(object, key);
        if (!value.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]")) {
            throw invalid(key, "expected HH:mm:ss");
        }
        try {
            return LocalTime.parse(value);
        } catch (DateTimeParseException error) {
            throw invalid(key, "invalid local time");
        }
    }

    static ZoneId requiredZoneId(JSONObject object, String key) throws JSONException {
        String value = requiredString(object, key);
        if (!ZoneId.getAvailableZoneIds().contains(value)) {
            throw invalid(key, "unknown IANA timezone");
        }
        try {
            return ZoneId.of(value);
        } catch (DateTimeException error) {
            throw invalid(key, "unknown IANA timezone");
        }
    }

    static List<String> requiredDays(JSONObject object, String key) throws JSONException {
        Object raw = object.get(key);
        if (!(raw instanceof JSONArray)) {
            throw invalid(key, "expected array");
        }
        JSONArray array = (JSONArray) raw;
        if (array.length() == 0) {
            throw invalid(key, "must not be empty");
        }
        List<String> result = new ArrayList<>();
        Set<String> unique = new HashSet<>();
        for (int index = 0; index < array.length(); index++) {
            Object item = array.get(index);
            if (!(item instanceof String)
                    || !DAYS.contains(item)
                    || !unique.add((String) item)) {
                throw invalid(key, "contains invalid or duplicate day");
            }
            result.add((String) item);
        }
        return Collections.unmodifiableList(result);
    }

    static JSONObject requiredObject(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof JSONObject)) {
            throw invalid(key, "expected object");
        }
        return (JSONObject) value;
    }

    static JSONArray requiredArray(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof JSONArray)) {
            throw invalid(key, "expected array");
        }
        return (JSONArray) value;
    }

    static JSONException invalid(String key, String reason) {
        return new JSONException("Invalid " + key + ": " + reason);
    }

    private static String uuid(String value, String key) throws JSONException {
        String canonical = value.toLowerCase(Locale.ROOT);
        try {
            if (!UUID.fromString(canonical).toString().equals(canonical)) {
                throw new IllegalArgumentException();
            }
            return canonical;
        } catch (IllegalArgumentException error) {
            throw invalid(key, "expected UUID");
        }
    }

    private static Instant instant(String value, String key) throws JSONException {
        if (!value.endsWith("Z")) {
            throw invalid(key, "expected UTC ISO 8601 timestamp");
        }
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException error) {
            throw invalid(key, "expected UTC ISO 8601 timestamp");
        }
    }

    private static BigDecimal decimal(JSONObject object, String key, boolean allowZero)
            throws JSONException {
        Object raw = object.get(key);
        if (!(raw instanceof Number)) {
            throw invalid(key, "expected JSON number");
        }
        try {
            BigDecimal value = new BigDecimal(raw.toString());
            if (value.stripTrailingZeros().scale() > 2
                    || value.compareTo(MAX_GRAMS) > 0
                    || !allowZero && value.signum() == 0) {
                throw new NumberFormatException();
            }
            return value;
        } catch (NumberFormatException error) {
            throw invalid(key, "outside numeric(8,2)");
        }
    }
}
