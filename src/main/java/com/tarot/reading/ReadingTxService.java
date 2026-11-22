package com.tarot.reading;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * 扣额度 + 建任务 + 记流水，放在同一个事务里。
 *
 * 单独抽成一个 Bean 的原因（面试高频点）：
 *   如果把 @Transactional 方法写在同一个类里被本类方法调用，走不到代理，事务不生效。
 *   Spring 的事务是基于 AOP 代理的，自调用不经过代理 → 注解白写。
 */
@Service
public class ReadingTxService {

    public record Submission(String taskId, int balance) {}

    public static class NoCreditsException extends RuntimeException {
        public NoCreditsException() { super("额度不足"); }
    }

    private final JdbcTemplate jdbc;

    public ReadingTxService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public Submission submit(long userId, String question, String cardsJson) {
        int deducted = jdbc.update(
                "UPDATE users SET credits = credits - 1, updated_at = NOW() WHERE id = ? AND credits > 0",
                userId);
        if (deducted == 0) {
            throw new NoCreditsException();
        }

        Integer balance = jdbc.queryForObject("SELECT credits FROM users WHERE id = ?", Integer.class, userId);
        String taskId = UUID.randomUUID().toString();

        jdbc.update("""
                INSERT INTO reading_tasks (task_id, user_id, question, cards_json, status)
                VALUES (?, ?, ?, ?, 'queued')
                """, taskId, userId, question, cardsJson);

        List<Long> ids = jdbc.queryForList(
                "SELECT id FROM reading_tasks WHERE task_id = ?", Long.class, taskId);
        long taskRowId = ids.isEmpty() ? 0 : ids.get(0);

        jdbc.update("""
                INSERT INTO credit_transactions (user_id, delta, balance, source, ref_id)
                VALUES (?, -1, ?, 'reading_async', ?)
                """, userId, balance, taskRowId);

        return new Submission(taskId, balance == null ? 0 : balance);
    }
}
