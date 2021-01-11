module.exports = omegga => {
  // patterns for leave message and host detection
  const hostRegExp = /^Logged in as (?<name>.+) \((?<id>[0-9a-fA-F-]{36})\)\.$/;
  const invalidRegExp = /^(Error: AuthState is Invalid on dedicated server - exiting\.|Changing AuthState from \w+ to Invalid\.)$/;
  const validRegExp = /^Changing AuthState from \w+ to Valid(Online|Offline)\.$/;

  return {
    // listen for auth messages
    pattern(_line, logMatch) {
      // line is not generic console log
      if (!logMatch) return;

      const { generator, data } = logMatch.groups;
      // check if log is an auth log
      if (generator !== 'LogAuthManager') return;

      // match against the patterns
      const hostMatch = data.match(hostRegExp);
      const invalidMatch = data.match(invalidRegExp);
      const validMatch = data.match(validRegExp);

      // if the log matches one of the patterns, return the result
      if (hostMatch) {
        const { name, id } = hostMatch.groups;
        return ['host', { name, id }];
      } else if (invalidMatch) {
        return ['invalid', null];
      } else if (validMatch) {
        return ['valid', null];
      }
    },
    // when there's a match, emit the chat message event
    callback([type, host]) {
      if (type == 'host') {
        // store the host info
        omegga.host = Object.freeze(host);
        omegga.emit('host', Object.freeze(host));
      } else if (type === 'valid') {
        // begin omegga prestart
        omegga.prestart();
      } else if (type === 'invalid') {
        omegga.emit('unauthorized');
        // do nothing with invalid auth?? how did we get here
      }
    },
  };
};
