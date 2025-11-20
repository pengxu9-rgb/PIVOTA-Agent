# Anthropic Claude Integration Guide

**Version: 1.0**  
*Integration guide for Pivota Shopping Agent with Anthropic Claude*

## Status: TODO

This integration is planned but not yet implemented.

## Overview

Claude provides tool use capabilities that can integrate with the Pivota Shopping Agent. This guide will cover:
- Setting up Claude API access
- Configuring tool definitions
- Implementing the tool use flow
- Handling Claude-specific features and constraints

## Prerequisites

1. **Anthropic API Key** from [console.anthropic.com](https://console.anthropic.com/)
2. **Pivota Agent Gateway** deployed and accessible
3. **Claude API SDK** installed

## Implementation Notes

### Key Differences from OpenAI
- Tool definition format
- Message structure requirements
- Token limit handling
- Response parsing patterns

### Planned Features
- [ ] Basic tool use implementation
- [ ] Multi-step conversation flows
- [ ] Claude-specific prompt optimizations
- [ ] Error handling and retries

## Code Structure (Placeholder)

```javascript
// TODO: Implement Claude integration
import Anthropic from '@anthropic-ai/sdk';

// Initialize Claude client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Define tool for Claude
const tools = [{
  name: "pivota_shopping_tool",
  description: "Unified shopping tool for Pivota platform",
  input_schema: {
    // Tool schema adapted for Claude format
  }
}];

// Main conversation flow
async function runClaudeAgent(userMessage) {
  // TODO: Implement conversation logic with tool use
  const message = await anthropic.messages.create({
    model: "claude-3-opus-20240229",
    max_tokens: 1024,
    tools: tools,
    messages: [{
      role: "user",
      content: userMessage
    }]
  });
  
  // Handle tool use responses
}
```

## Integration Considerations

### Tool Use Best Practices
- Clear tool descriptions
- Structured input schemas
- Proper error messages
- State management across turns

### Claude-Specific Optimizations
- Leverage Claude's reasoning capabilities
- Use XML tags for structured data
- Implement proper conversation memory

## Resources

- [Anthropic Documentation](https://docs.anthropic.com/)
- [Tool Use Guide](https://docs.anthropic.com/claude/docs/tool-use)
- [API Reference](https://docs.anthropic.com/claude/reference/messages)

## Contributing

To implement this integration:
1. Review Claude's tool use documentation
2. Adapt the Pivota tool schema
3. Create `demo-claude-pivota.mjs`
4. Test all shopping operations
5. Update this guide with working examples
