import {
  WorkflowMigratorError,
  ParseError,
  ValidationError,
  ConversionError,
  ErrorCode,
  getExitCode,
} from '../../utils/errors';

describe('Error Hierarchy', () => {
  describe('WorkflowMigratorError', () => {
    it('should set code, message, and context', () => {
      const error = new WorkflowMigratorError(
        ErrorCode.FILE_NOT_FOUND,
        'File not found',
        { path: '/test.json' }
      );

      expect(error.code).toBe(ErrorCode.FILE_NOT_FOUND);
      expect(error.message).toBe('File not found');
      expect(error.context).toEqual({ path: '/test.json' });
      expect(error.name).toBe('WorkflowMigratorError');
    });

    it('should be an instance of Error', () => {
      const error = new WorkflowMigratorError(ErrorCode.INVALID_INPUT, 'test');
      expect(error).toBeInstanceOf(Error);
    });

    it('should have a stack trace', () => {
      const error = new WorkflowMigratorError(ErrorCode.INVALID_INPUT, 'test');
      expect(error.stack).toBeDefined();
    });
  });

  describe('ParseError', () => {
    it('should have PARSE_ERROR code', () => {
      const error = new ParseError('bad json');
      expect(error.code).toBe(ErrorCode.PARSE_ERROR);
      expect(error.name).toBe('ParseError');
    });

    it('should be an instance of WorkflowMigratorError', () => {
      const error = new ParseError('bad json');
      expect(error).toBeInstanceOf(WorkflowMigratorError);
    });
  });

  describe('ValidationError', () => {
    it('should have VALIDATION_ERROR code', () => {
      const error = new ValidationError('missing field');
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.name).toBe('ValidationError');
    });
  });

  describe('ConversionError', () => {
    it('should have CONVERSION_ERROR code', () => {
      const error = new ConversionError('conversion failed');
      expect(error.code).toBe(ErrorCode.CONVERSION_ERROR);
      expect(error.name).toBe('ConversionError');
    });
  });
});

describe('getExitCode', () => {
  it('should return 1 for user input errors', () => {
    expect(getExitCode(new WorkflowMigratorError(ErrorCode.FILE_NOT_FOUND, ''))).toBe(1);
    expect(getExitCode(new WorkflowMigratorError(ErrorCode.INVALID_INPUT, ''))).toBe(1);
    expect(getExitCode(new WorkflowMigratorError(ErrorCode.UNSUPPORTED_PLATFORM, ''))).toBe(1);
  });

  it('should return 2 for parse/validation errors', () => {
    expect(getExitCode(new ParseError(''))).toBe(2);
    expect(getExitCode(new ValidationError(''))).toBe(2);
  });

  it('should return 3 for conversion errors', () => {
    expect(getExitCode(new ConversionError(''))).toBe(3);
  });

  it('should return 4 for file too large', () => {
    expect(getExitCode(new WorkflowMigratorError(ErrorCode.FILE_TOO_LARGE, ''))).toBe(4);
  });
});
