import adapter from '@sveltejs/adapter-node';

export default {
  kit: {
    adapter: adapter({
      out: 'build'
    }),
    // SvelteKit adds a fresh nonce to its hydration bootstrap on each dynamic
    // response. This keeps the page executable without allowing arbitrary
    // inline scripts, while the HTTP host applies the matching policy to APIs.
    csp: {
      mode: 'nonce',
      directives: {
        'default-src': ['self'],
        'base-uri': ['self'],
        'object-src': ['none'],
        'frame-ancestors': ['none'],
        'form-action': ['self'],
        'script-src': ['self'],
        'style-src': ['self'],
        'img-src': ['self', 'data:'],
        'font-src': ['self'],
        'connect-src': ['self', 'ws:', 'wss:']
      }
    }
  }
};
