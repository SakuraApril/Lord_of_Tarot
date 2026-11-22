package com.tarot.common;

import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Component;

import java.util.Map;

/** MQ 健康检查：能声明队列就算健康 */
@Component
public class RabbitHealth {

    private final RabbitTemplate rabbitTemplate;

    public RabbitHealth(RabbitTemplate rabbitTemplate) {
        this.rabbitTemplate = rabbitTemplate;
    }

    public Map<String, Object> check() {
        try {
            Long dead = rabbitTemplate.execute(channel -> {
                var ok = channel.queueDeclarePassive("reading.dead");
                return (long) ok.getMessageCount();
            });
            return Map.of("ok", true, "deadLetterCount", dead == null ? 0 : dead);
        } catch (Exception e) {
            return Map.of("ok", false, "error", String.valueOf(e.getMessage()));
        }
    }
}
