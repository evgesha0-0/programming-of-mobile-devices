package ru.smartcatfeeder;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Объединяет страницы истории и не допускает повторного отображения событий. */
public final class FeedingHistoryState {
    private final List<Feeding> items = new ArrayList<>();
    private final Set<String> feedingIds = new HashSet<>();
    private String nextCursor;

    public void applyFirstPage(FeedingHistoryPage page) {
        items.clear();
        feedingIds.clear();
        nextCursor = null;
        appendItems(Objects.requireNonNull(page, "page"));
        nextCursor = page.nextCursor;
    }

    public void appendPage(FeedingHistoryPage page) {
        Objects.requireNonNull(page, "page");
        String requestedCursor = nextCursor;
        appendItems(page);
        nextCursor = Objects.equals(requestedCursor, page.nextCursor)
                ? null
                : page.nextCursor;
    }

    public List<Feeding> items() {
        return Collections.unmodifiableList(new ArrayList<>(items));
    }

    public String nextCursor() {
        return nextCursor;
    }

    public boolean hasMore() {
        return nextCursor != null;
    }

    private void appendItems(FeedingHistoryPage page) {
        for (Feeding feeding : page.items) {
            if (feedingIds.add(feeding.feedingId)) {
                items.add(feeding);
            }
        }
    }
}
