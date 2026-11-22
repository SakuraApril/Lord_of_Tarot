package com.tarot.worker;

import com.rabbitmq.client.Channel;
import com.tarot.config.RabbitConfig;
import org.springframework.amqp.AmqpRejectAndDontRequeueException;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.amqp.support.AmqpHeaders;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 解读任务消费者（手动 ack）
 *
 * 三个要点：
 *   1. 处理成功才 ack；抛异常时 Spring 会 nack，但这里我们自己控制重试次数
 *   2. 幂等：先看任务状态，已完成直接 ack（消息可能重复投递）
 *   3. 补偿：重试 3 次仍失败 → 标记 failed + 退额度 + 退款流水
 */
@Component
public class ReadingWorker {

    private static final int MAX_ATTEMPTS = 3;

    private final JdbcTemplate jdbc;
    private final RabbitTemplate rabbit;
    private final String apiKey;
    private final String baseUrl;
    private final String model;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    public ReadingWorker(JdbcTemplate jdbc,
                         RabbitTemplate rabbit,
                         @Value("${app.openai.api-key:}") String apiKey,
                         @Value("${app.openai.base-url:https://api.openai.com/v1}") String baseUrl,
                         @Value("${app.openai.model:gpt-4o-mini}") String model) {
        this.jdbc = jdbc;
        this.rabbit = rabbit;
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.model = model;
    }

    @RabbitListener(queues = RabbitConfig.JOB_QUEUE)
    public void handle(Map<String, Object> job,
                       Channel channel,
                       @Header(AmqpHeaders.DELIVERY_TAG) long deliveryTag) throws Exception {
        String taskId = String.valueOf(job.get("taskId"));
        int attempts = job.get("attempts") == null ? 0 : ((Number) job.get("attempts")).intValue();

        try {
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT id, user_id, question, cards_json, status FROM reading_tasks WHERE task_id = ?", taskId);
            if (rows.isEmpty()) {
                channel.basicAck(deliveryTag, false);
                return;
            }
            Map<String, Object> task = rows.get(0);
            if ("done".equals(task.get("status"))) {
                channel.basicAck(deliveryTag, false);
                return;
            }

            long userId = ((Number) task.get("user_id")).longValue();
            jdbc.update("UPDATE reading_tasks SET status = 'processing', attempts = attempts + 1 WHERE task_id = ?", taskId);

            String question = String.valueOf(task.get("question"));
            String cardsJson = String.valueOf(task.get("cards_json"));
            String answer = generate(question, cardsJson);

            jdbc.update("""
                    INSERT INTO readings (user_id, question, spread_type, cards_json, ai_response)
                    VALUES (?, ?, ?, ?, ?)
                    """, userId, question, spreadType(cardsJson), cardsJson, answer);

            Long readingId = jdbc.queryForObject(
                    "SELECT MAX(id) FROM readings WHERE user_id = ?", Long.class, userId);
            jdbc.update("UPDATE reading_tasks SET status = 'done', reading_id = ?, ai_response = ?, error = NULL WHERE task_id = ?",
                    readingId, answer, taskId);

            channel.basicAck(deliveryTag, false);
        } catch (Exception e) {
            int next = attempts + 1;
            if (next < MAX_ATTEMPTS) {
                // 退避后重新发布；不用 requeue：requeue 会立刻回到队首，模型挂掉就是热循环
                scheduler.schedule(() -> {
                    job.put("attempts", next);
                    try {
                        rabbit.convertAndSend(RabbitConfig.JOB_EXCHANGE, RabbitConfig.JOB_ROUTING_KEY, job);
                    } catch (Exception ignored) { }
                }, 2L * next, TimeUnit.SECONDS);
                channel.basicAck(deliveryTag, false);
            } else {
                compensate(taskId);
                channel.basicAck(deliveryTag, false);
            }
        }
    }

    private String spreadType(String cardsJson) {
        int count = cardsJson.split("\"nameZh\"").length - 1;
        if (count >= 10) return "celtic";
        if (count >= 3) return "three";
        return "single";
    }

    /** 重试耗尽：标记失败 + 退额度 + 退款流水 */
    private void compensate(String taskId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT user_id, status FROM reading_tasks WHERE task_id = ?", taskId);
        if (rows.isEmpty() || "done".equals(rows.get(0).get("status"))) return;
        long userId = ((Number) rows.get(0).get("user_id")).longValue();

        jdbc.update("UPDATE reading_tasks SET status = 'failed', error = ? WHERE task_id = ?",
                "生成失败，已重试 " + MAX_ATTEMPTS + " 次", taskId);
        jdbc.update("UPDATE users SET credits = credits + 1, updated_at = NOW() WHERE id = ?", userId);
        Integer balance = jdbc.queryForObject("SELECT credits FROM users WHERE id = ?", Integer.class, userId);
        jdbc.update("INSERT INTO credit_transactions (user_id, delta, balance, source) VALUES (?, 1, ?, 'refund')",
                userId, balance);
    }

    /** 没有 API Key 时用 mock，保证本地能把链路跑通 */
    private String generate(String question, String cardsJson) throws Exception {
        if (apiKey == null || apiKey.isBlank() || "sk-dummy".equals(apiKey)) {
            Thread.sleep(200);
            if ("1".equals(System.getenv("MOCK_FAIL"))) throw new IllegalStateException("mock 模式：模拟模型调用失败");
            return "【mock 解读】关于「" + question + "」，牌面为 " + cardsJson
                    + "。这是本地联调用的占位文本，配置 OPENAI_API_KEY 后替换为真实输出。";
        }

        String body = com.tarot.common.Json.write(Map.of(
                "model", model,
                "messages", List.of(
                        Map.of("role", "system", "content", "你是一位塔罗解读师，只做解读，不下断言。"),
                        Map.of("role", "user", "content", "问题：" + question + "\n牌面：" + cardsJson)),
                "temperature", 0.7,
                "max_tokens", 1500));

        var client = java.net.http.HttpClient.newHttpClient();
        var request = java.net.http.HttpRequest.newBuilder()
                .uri(java.net.URI.create(baseUrl.replaceAll("/$", "") + "/chat/completions"))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(java.net.http.HttpRequest.BodyPublishers.ofString(body))
                .build();
        var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 300) {
            throw new IllegalStateException("模型调用失败: HTTP " + response.statusCode());
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> parsed = com.tarot.common.Json.MAPPER.readValue(response.body(), Map.class);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> choices = (List<Map<String, Object>>) parsed.get("choices");
        @SuppressWarnings("unchecked")
        Map<String, Object> msg = (Map<String, Object>) choices.get(0).get("message");
        return String.valueOf(msg.get("content"));
    }
}
