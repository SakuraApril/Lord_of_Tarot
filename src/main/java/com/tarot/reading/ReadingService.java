package com.tarot.reading;

import com.tarot.common.Json;
import com.tarot.config.RabbitConfig;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 异步解读：幂等 → 扣额度（事务）→ 投递 MQ
 *
 * 幂等靠 idempotency_keys 的主键冲突：
 *   插入成功 = 第一次；DuplicateKeyException = 重复提交，直接回放上次结果。
 */
@Service
public class ReadingService {

    private final ReadingTxService tx;
    private final JdbcTemplate jdbc;
    private final RabbitTemplate rabbit;

    public ReadingService(ReadingTxService tx, JdbcTemplate jdbc, RabbitTemplate rabbit) {
        this.tx = tx;
        this.jdbc = jdbc;
        this.rabbit = rabbit;
    }

    public Map<String, Object> submit(long userId, String question, List<Map<String, Object>> cards, String requestId) {
        try {
            jdbc.update("INSERT INTO idempotency_keys (request_id, user_id, endpoint) VALUES (?, ?, ?)",
                    requestId, userId, "reading.async");
        } catch (DuplicateKeyException dup) {
            return replay(requestId);
        }

        ReadingTxService.Submission submission;
        try {
            submission = tx.submit(userId, question, Json.write(cards));
        } catch (ReadingTxService.NoCreditsException e) {
            markFailed(requestId, "额度不足");
            throw e;
        } catch (Exception e) {
            markFailed(requestId, e.getMessage());
            throw e;
        }

        Map<String, Object> message = new LinkedHashMap<>();
        message.put("taskId", submission.taskId());
        message.put("userId", userId);
        message.put("question", question);
        message.put("cards", cards);
        message.put("attempts", 0);

        try {
            rabbit.convertAndSend(RabbitConfig.JOB_EXCHANGE, RabbitConfig.JOB_ROUTING_KEY, message);
        } catch (Exception e) {
            // 投递失败 → 退回额度，避免用户被白扣
            jdbc.update("UPDATE users SET credits = credits + 1, updated_at = NOW() WHERE id = ?", userId);
            Integer balance = jdbc.queryForObject("SELECT credits FROM users WHERE id = ?", Integer.class, userId);
            jdbc.update("""
                    INSERT INTO credit_transactions (user_id, delta, balance, source)
                    VALUES (?, 1, ?, 'refund')
                    """, userId, balance);
            jdbc.update("UPDATE reading_tasks SET status = 'failed', error = ? WHERE task_id = ?",
                    "队列不可用", submission.taskId());
            markFailed(requestId, "队列不可用");
            throw new IllegalStateException("队列不可用", e);
        }

        Map<String, Object> body = Map.of(
                "taskId", submission.taskId(),
                "credits", submission.balance(),
                "status", "queued");
        try {
            jdbc.update("UPDATE idempotency_keys SET status = 'done', response_json = ? WHERE request_id = ?",
                    Json.MAPPER.writeValueAsString(body), requestId);
        } catch (Exception ignored) { }
        return body;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> replay(String requestId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT status, response_json FROM idempotency_keys WHERE request_id = ?", requestId);
        if (rows.isEmpty()) {
            throw new IllegalStateException("同一请求正在处理中");
        }
        String status = (String) rows.get(0).get("status");
        String json = (String) rows.get(0).get("response_json");
        if ("done".equals(status) && json != null) {
            try {
                Map<String, Object> body = new LinkedHashMap<>(Json.MAPPER.readValue(json, Map.class));
                body.put("replayed", true);
                return body;
            } catch (Exception ignored) { }
        }
        if ("processing".equals(status)) {
            throw new IllegalStateException("同一请求正在处理中");
        }
        // failed：允许重来一次
        jdbc.update("DELETE FROM idempotency_keys WHERE request_id = ?", requestId);
        throw new IllegalStateException("上次请求失败，请重试");
    }

    private void markFailed(String requestId, String message) {
        try {
            jdbc.update("UPDATE idempotency_keys SET status = 'failed', response_json = ? WHERE request_id = ?",
                    Json.MAPPER.writeValueAsString(Map.of("error", String.valueOf(message))), requestId);
        } catch (Exception ignored) { }
    }

    public Map<String, Object> taskStatus(long userId, String taskId) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT task_id, status, ai_response, reading_id, error, attempts
                FROM reading_tasks WHERE task_id = ? AND user_id = ?
                """, taskId, userId);
        if (rows.isEmpty()) return null;
        Map<String, Object> t = rows.get(0);
        boolean done = "done".equals(t.get("status"));
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("taskId", t.get("task_id"));
        resp.put("status", t.get("status"));
        resp.put("attempts", t.get("attempts"));
        resp.put("readingId", t.get("reading_id"));
        resp.put("content", done ? t.get("ai_response") : null);
        resp.put("error", t.get("error"));
        return resp;
    }
}
