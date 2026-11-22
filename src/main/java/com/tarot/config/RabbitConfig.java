package com.tarot.config;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * RabbitMQ 拓扑与序列化（与 Node 版一致）
 *
 *   reading.dx  → reading.jobs（durable，死信 → reading.dlx → reading.dead）
 *
 * 序列化统一用 JSON：
 *   JDK 序列化的消息只有 Java 能读；换成 JSON 之后，legacy 的 Node worker
 *   也能消费同一个队列，两种实现可以共存、可以灰度切换。
 */
@Configuration
public class RabbitConfig {

    public static final String JOB_EXCHANGE = "reading.dx";
    public static final String JOB_QUEUE = "reading.jobs";
    public static final String DLX = "reading.dlx";
    public static final String DEAD_QUEUE = "reading.dead";
    public static final String DEAD_ROUTING_KEY = "dead";
    public static final String JOB_ROUTING_KEY = "reading";

    /** Spring Boot 检测到这个 Bean 会自动装到 RabbitTemplate 与监听容器上 */
    @Bean
    public MessageConverter jsonMessageConverter() {
        return new Jackson2JsonMessageConverter();
    }

    @Bean
    public DirectExchange jobExchange() {
        return new DirectExchange(JOB_EXCHANGE, true, false);
    }

    @Bean
    public DirectExchange deadLetterExchange() {
        return new DirectExchange(DLX, true, false);
    }

    @Bean
    public Queue jobQueue() {
        return QueueBuilder.durable(JOB_QUEUE)
                .withArgument("x-dead-letter-exchange", DLX)
                .withArgument("x-dead-letter-routing-key", DEAD_ROUTING_KEY)
                .build();
    }

    @Bean
    public Queue deadQueue() {
        return QueueBuilder.durable(DEAD_QUEUE).build();
    }

    @Bean
    public Binding jobBinding() {
        return BindingBuilder.bind(jobQueue()).to(jobExchange()).with(JOB_ROUTING_KEY);
    }

    @Bean
    public Binding deadBinding() {
        return BindingBuilder.bind(deadQueue()).to(deadLetterExchange()).with(DEAD_ROUTING_KEY);
    }
}
