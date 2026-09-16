/**
 * Boots Swagger UI. A separate file rather than an inline script because the
 * app's CSP allows scripts from 'self' only — an inline initialiser would be
 * blocked with no visible error.
 */
window.SwaggerUIBundle({
  url: '/app/society/api-docs/openapi.json',
  dom_id: '#swagger',
  deepLinking: true,
  docExpansion: 'none',
  defaultModelsExpandDepth: 0,
  defaultModelRendering: 'example',
  displayRequestDuration: true,
  filter: true,
  persistAuthorization: true,
  tryItOutEnabled: true,
  syntaxHighlight: { theme: 'idea' },
  presets: [window.SwaggerUIBundle.presets.apis],
});
